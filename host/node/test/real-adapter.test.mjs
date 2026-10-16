// The real Easy-LLM OpenAI adapter, making real HTTP requests to a local mock endpoint,
// through the Rust executor. This is the path a production provider takes, minus the
// network and the credentials.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import * as easyLlm from "@easy-llm/llm";

import { startMockServer } from "../examples/mock-server.mjs";
import { createFxRuntime } from "../src/index.js";

const KEY = "sk-MOCKKEYMOCKKEYMOCKKEY0123456789";
const RID = "00112233445566778899aabbccddeeff";

const request = (model, over = {}) => ({
  v: 1,
  model,
  messages: [{ role: "user", parts: [{ type: "text", text: "say hi" }] }],
  correlation: { request_id: RID },
  ...over,
});

let server;
let runtime;
let provider;
before(async () => {
  server = await startMockServer();
  runtime = await createFxRuntime({ easyLlm });
  provider = easyLlm.createOpenAIAdapter(KEY, server.url);
});
after(async () => {
  await server.close();
});

const outcomeOf = (result) => result.report.outcome;
const waitFor = async (predicate, ms = 1000) => {
  const until = Date.now() + ms;
  while (!predicate() && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
};

describe("the real OpenAI adapter through the Rust executor", () => {
  test("streams a completion: ordered deltas, finish reason, one HTTP request", async () => {
    const before = server.requests.length;
    const seen = [];
    const result = await runtime.execute(request("ok"), { provider, mode: "stream", onEvent: (e) => { seen.push(e.type); } });
    assert.equal(server.requests.length - before, 1, "exactly one HTTP request");
    assert.deepEqual(seen, ["text_delta", "text_delta", "finish"]);
    const outcome = outcomeOf(result);
    assert.equal(outcome.type, "completed");
    assert.equal(outcome.content, "Hello world");
    assert.equal(outcome.finish_reason, "stop");
    assert.equal(result.report.diagnostics.delivery, "confirmed_response");
    assert.equal(result.host.providerId, "openai");
    assert.equal(result.host.transportRetries, "none");
    assert.equal(server.requests.at(-1).authorization, `Bearer ${KEY}`, "the key reached the provider through Easy-LLM");
    assert.ok(!JSON.stringify(result).includes(KEY), "and appears nowhere in the FX result");
  });

  test("collects a completion with usage and the provider's finish reason", async () => {
    const result = await runtime.execute(request("ok"), { provider, mode: "generate" });
    const outcome = outcomeOf(result);
    assert.equal(outcome.type, "completed");
    assert.equal(outcome.content, "Hello world");
    assert.equal(outcome.finish_reason, "stop");
    assert.equal(outcome.usage.input_tokens, 5);
    assert.equal(outcome.usage.output_tokens, 2);
  });

  test("a 429 is reported with its status and Retry-After, and is not retried", async () => {
    const before = server.requests.length;
    for (const mode of ["generate", "stream"]) {
      const result = await runtime.execute(request("ratelimit"), { provider, mode });
      const outcome = outcomeOf(result);
      assert.equal(outcome.type, "failed", mode);
      assert.equal(outcome.origin, "capability", mode);
      assert.equal(outcome.kind, "rate_limited", mode);
      assert.equal(outcome.status_hint, 429, mode);
      assert.equal(outcome.retry_after_ms, 3000, mode);
      assert.equal(outcome.delivery, "possibly_sent", mode);
    }
    assert.equal(server.requests.length - before, 2, "one HTTP request per attempt, no retry");
  });

  test("a 401 is unauthenticated; the category comes from the status, not the text", async () => {
    const outcome = outcomeOf(await runtime.execute(request("unauthorized"), { provider, mode: "generate" }));
    assert.equal(outcome.kind, "unauthenticated");
    assert.equal(outcome.status_hint, 401);

    const misleading = outcomeOf(await runtime.execute(request("server-error"), { provider, mode: "generate" }));
    assert.equal(misleading.kind, "provider_unavailable", "a 500 whose text mentions 429 and 401 is still a 500");
    assert.equal(misleading.status_hint, 500);
  });

  test("a stream with no finish_reason is an interruption, never a success", async () => {
    const result = await runtime.execute(request("truncated"), { provider, mode: "stream" });
    const outcome = outcomeOf(result);
    assert.equal(outcome.type, "failed");
    assert.equal(outcome.origin, "executor");
    assert.equal(outcome.kind, "transport");
    assert.equal(outcome.partial.content, "cut off");
    assert.notEqual(result.report.diagnostics.terminal.type, "finished");
  });

  test("a connection reset after partial output is a failure that keeps the partial output", async () => {
    const outcome = outcomeOf(await runtime.execute(request("reset"), { provider, mode: "stream" }));
    assert.equal(outcome.type, "failed");
    assert.equal(outcome.partial.content, "partial ");
    assert.equal(outcome.delivery, "confirmed_response");
    assert.equal(outcome.status_hint, null, "no HTTP status exists for a reset connection");
  });

  test("cancelling closes the HTTP connection", async () => {
    for (const mode of ["stream", "generate"]) {
      const closedBefore = server.aborted();
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 50);
      const outcome = outcomeOf(await runtime.execute(request("hang"), { provider, mode, signal: controller.signal }));
      assert.equal(outcome.type, "cancelled", mode);
      assert.equal(outcome.delivery, "possibly_sent", mode);
      assert.equal(outcome.remote, "unconfirmed", mode);
      await waitFor(() => server.aborted() > closedBefore);
      assert.equal(server.aborted(), closedBefore + 1, `${mode}: the server saw the client drop the connection`);
    }
  });

  test("the attempt budget cancels the HTTP request and is a timeout", async () => {
    const closedBefore = server.aborted();
    const outcome = outcomeOf(await runtime.execute(request("hang", { budget_ms: 60 }), { provider, mode: "stream" }));
    assert.equal(outcome.kind, "timeout");
    assert.equal(outcome.delivery, "possibly_sent");
    await waitFor(() => server.aborted() > closedBefore);
    assert.equal(server.aborted(), closedBefore + 1);
  });

  test("requests the adapter cannot carry never reach the network", async () => {
    const before = server.requests.length;
    const tool = { name: "list_files", description: "d", input_schema_json: '{"type":"object"}' };
    for (const doc of [request("ok", { tools: [tool] }), request("ok", { options: { max_output_tokens: 5 } }), request("", {})]) {
      for (const mode of ["generate", "stream"]) await runtime.execute(doc, { provider, mode });
    }
    assert.equal(server.requests.length, before, "no HTTP request was made");
  });

  test("a provider id resolves through Easy-LLM's registry without routing", async () => {
    easyLlm.llm.registerProvider(provider);
    try {
      const before = server.requests.length;
      const result = await runtime.execute(request("ok"), { provider: "openai", mode: "stream" });
      assert.equal(outcomeOf(result).content, "Hello world");
      assert.equal(server.requests.length - before, 1);
    } finally {
      easyLlm.llm.clearProviders();
    }
  });
});
