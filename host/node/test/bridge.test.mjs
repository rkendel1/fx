// End to end: the real Rust executor (WebAssembly) driven through the host bridge,
// against the real Easy-LLM generateOnce / streamOnce, with deterministic mock providers.
// No network and no credentials.

import assert from "node:assert/strict";
import { describe, test, before } from "node:test";

import * as easyLlm from "@easy-llm/llm";
import { ProviderError } from "@easy-llm/llm";

import { createFxRuntime, HostProtocolError } from "../src/index.js";
import { loadModule } from "../src/wasm.js";

const RID = "00112233445566778899aabbccddeeff";
const SECRET = "sk-SECRETSECRETSECRET0123456789";

/** @param {Record<string, unknown>} [over] */
const request = (over = {}) => ({
  v: 1,
  model: "example/model-1",
  messages: [{ role: "user", parts: [{ type: "text", text: "say hi" }] }],
  correlation: { request_id: RID },
  ...over,
});

/**
 * A mock Easy-LLM provider. `supports` throws: the single-attempt path must never call it.
 * @param {string} id
 * @param {{ generate?: Function, stream?: Function, traits?: object }} behavior
 */
function mock(id, { generate, stream, traits }) {
  const calls = { generate: 0, stream: 0, signals: [] };
  return {
    id,
    calls,
    attemptTraits: traits,
    supports() {
      throw new Error("supports() must not be called by a single-attempt call");
    },
    generate: async (req) => {
      calls.generate += 1;
      calls.signals.push(req.signal);
      if (!generate) throw new Error("generate not scripted");
      return generate(req);
    },
    ...(stream && {
      stream: (req) => {
        calls.stream += 1;
        calls.signals.push(req.signal);
        return stream(req);
      },
    }),
  };
}

async function* chunks(...items) {
  for (const item of items) {
    if (item instanceof Error) throw item;
    yield item;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const outcomeOf = (result) => result.report.outcome;
const PROOF = { transportRetries: "none", abortSignal: true, doneIsTerminalProof: true };

let runtime;
before(async () => {
  runtime = await createFxRuntime({ easyLlm });
});

describe("request lifecycle", () => {
  test("a valid request reaches the selected provider once and completes", async () => {
    const provider = mock("p", { generate: () => ({ text: "hello", model: "m-1", finishReason: "stop", usage: { inputTokens: 4, outputTokens: 2 } }) });
    const result = await runtime.execute(request(), { provider, mode: "generate" });
    assert.equal(provider.calls.generate, 1);
    const outcome = outcomeOf(result);
    assert.equal(outcome.type, "completed");
    assert.equal(outcome.content, "hello");
    assert.equal(outcome.finish_reason, "stop");
    assert.equal(outcome.usage.input_tokens, 4);
    assert.equal(outcome.usage.output_tokens, 2);
    assert.equal(outcome.usage.reasoning_tokens, null, "unreported usage stays unknown, never zero");
    assert.equal(outcome.metadata.model_reported, "m-1");
    assert.equal(result.report.diagnostics.starts, 1);
    assert.equal(result.report.diagnostics.closes, 1);
    assert.equal(result.host.providerInvoked, true);
  });

  test("an invalid request is rejected before the provider is invoked", async () => {
    const provider = mock("p", { generate: () => ({ text: "x", model: "m" }), stream: () => chunks({ type: "done" }) });
    for (const doc of [request({ model: "" }), request({ messages: [] }), "{", new Uint8Array([0xff, 0xfe])]) {
      const result = await runtime.execute(doc, { provider });
      const outcome = outcomeOf(result);
      assert.equal(outcome.type, "failed");
      assert.equal(outcome.kind, "invalid_request");
      assert.equal(outcome.delivery, "definitely_unsent");
      assert.equal(result.report.diagnostics.starts, 0);
      assert.equal(result.host.providerInvoked, false);
    }
    assert.deepEqual([provider.calls.generate, provider.calls.stream], [0, 0]);
  });

  test("the bridge cannot be used to bypass validation: duplicate keys are rejected as sent", async () => {
    const provider = mock("p", { generate: () => ({ text: "x", model: "m" }) });
    const duplicate = `{"v":1,"model":"a","model":"b","messages":[{"role":"user","parts":[{"type":"text","text":"x"}]}],"correlation":{"request_id":"${RID}"}}`;
    const result = await runtime.execute(duplicate, { provider, mode: "generate" });
    assert.equal(outcomeOf(result).kind, "invalid_request");
    assert.equal(provider.calls.generate, 0);
  });

  test("a provider failure is returned as the outcome: no retry, no fallback", async () => {
    const primary = mock("primary", {
      generate: () => {
        throw new ProviderError("GENERATION_FAILED", "rate limited", "primary", true, { status: 429, retryAfterMs: 5000 });
      },
    });
    const backup = mock("backup", { generate: () => ({ text: "from backup", model: "b" }) });
    easyLlm.llm.registerProvider(primary);
    easyLlm.llm.registerProvider(backup);
    try {
      const result = await runtime.execute(request(), { provider: "primary", mode: "generate" });
      const outcome = outcomeOf(result);
      assert.equal(outcome.type, "failed");
      assert.equal(outcome.origin, "capability");
      assert.equal(outcome.kind, "rate_limited");
      assert.equal(outcome.status_hint, 429);
      assert.equal(outcome.retry_after_ms, 5000);
      assert.equal(outcome.delivery, "possibly_sent");
      assert.equal(primary.calls.generate, 1, "the provider is called exactly once");
      assert.equal(backup.calls.generate, 0, "no other provider is tried");
    } finally {
      easyLlm.llm.clearProviders();
    }
  });

  test("an error without a status is not classified from its text", async () => {
    const provider = mock("p", { generate: () => { throw new Error("HTTP 429 rate limit exceeded, unauthorized 401"); } });
    const outcome = outcomeOf(await runtime.execute(request(), { provider, mode: "generate" }));
    assert.equal(outcome.kind, "transport");
    assert.equal(outcome.status_hint, null, "no status was supplied, so none is invented");
  });

  test("an unknown provider id is definitely unsent", async () => {
    easyLlm.llm.clearProviders();
    const result = await runtime.execute(request(), { provider: "no-such-provider", mode: "generate" });
    const outcome = outcomeOf(result);
    assert.equal(outcome.kind, "capability_unavailable");
    assert.equal(outcome.delivery, "definitely_unsent");
    assert.equal(result.host.providerInvoked, false);
  });

  test("requests the provider path cannot carry fail before dispatch", async () => {
    const provider = mock("p", { generate: () => ({ text: "x", model: "m" }), stream: () => chunks({ type: "done" }) });
    const png = Buffer.from("\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR", "latin1").toString("base64");
    const tool = { name: "list_files", description: "d", input_schema_json: '{"type":"object"}' };
    const cases = {
      "generation options": request({ options: { max_output_tokens: 10 } }),
      "tool definitions": request({ tools: [tool] }),
      "tool choice": request({ tools: [tool], tool_choice: { type: "required" } }),
      "structured output": request({ options: { response_format: { name: "n", description: "d", schema_json: "{}" } } }),
      "image parts": request({ messages: [{ role: "user", parts: [{ type: "image", media_type: "image/png", data_base64: png }] }] }),
    };
    for (const [label, doc] of Object.entries(cases)) {
      for (const mode of ["generate", "stream"]) {
        const result = await runtime.execute(doc, { provider, mode });
        const outcome = outcomeOf(result);
        assert.equal(outcome.kind, "capability_unavailable", `${label} ${mode}`);
        assert.equal(outcome.delivery, "definitely_unsent", `${label} ${mode}`);
        assert.equal(result.host.providerInvoked, false, `${label} ${mode}`);
      }
    }
    assert.deepEqual([provider.calls.generate, provider.calls.stream], [0, 0]);
  });

  test("a provider must be given explicitly", async () => {
    await assert.rejects(runtime.execute(request(), {}), TypeError);
    await assert.rejects(runtime.execute(request(), { provider: "id-without-mode" }), TypeError);
  });

  test("concurrent attempts are independent", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => {
        const provider = mock(`p${i}`, { stream: () => chunks({ type: "text", text: `answer ${i}` }, { type: "done", finishReason: "stop" }), traits: PROOF });
        return runtime.execute(request(), { provider, mode: "stream" });
      }),
    );
    results.forEach((result, i) => assert.equal(outcomeOf(result).content, `answer ${i}`));
  });
});

describe("output", () => {
  test("streamed deltas arrive in order, then the finish", async () => {
    const provider = mock("p", {
      traits: PROOF,
      stream: () => chunks({ type: "text", text: "a" }, { type: "text", text: "b" }, { type: "text", text: "c" }, { type: "done", finishReason: "stop", usage: { inputTokens: 9, outputTokens: 3 } }),
    });
    const seen = [];
    const result = await runtime.execute(request(), { provider, mode: "stream", onEvent: (e) => { seen.push(e.type); } });
    assert.deepEqual(seen, ["text_delta", "text_delta", "text_delta", "usage", "finish"]);
    assert.deepEqual(result.events.filter((e) => e.type === "text_delta").map((e) => e.text), ["a", "b", "c"]);
    const outcome = outcomeOf(result);
    assert.equal(outcome.content, "abc");
    assert.equal(outcome.finish_reason, "stop");
    assert.equal(outcome.usage.input_tokens, 9);
    assert.equal(outcome.usage.output_tokens, 3);
    assert.equal(result.report.diagnostics.delivery, "confirmed_response");
    assert.equal(provider.calls.stream, 1);
  });

  test("an empty stream is an interruption, never a success", async () => {
    const provider = mock("p", { traits: PROOF, stream: () => chunks() });
    const outcome = outcomeOf(await runtime.execute(request(), { provider, mode: "stream" }));
    assert.equal(outcome.type, "failed");
    assert.equal(outcome.origin, "executor");
    assert.equal(outcome.kind, "transport");
    assert.equal(outcome.partial, null);
  });

  test("a stream that ends without done keeps the partial output as a failure", async () => {
    const provider = mock("p", { traits: PROOF, stream: () => chunks({ type: "text", text: "par" }, { type: "text", text: "tial" }) });
    const outcome = outcomeOf(await runtime.execute(request(), { provider, mode: "stream" }));
    assert.equal(outcome.type, "failed");
    assert.equal(outcome.kind, "transport");
    assert.equal(outcome.partial.content, "partial");
  });

  test("a synthesized done with no finish reason is not turned into a success", async () => {
    const synthesizing = mock("p", { traits: { doneIsTerminalProof: false }, stream: () => chunks({ type: "text", text: "cut off" }, { type: "done" }) });
    const outcome = outcomeOf(await runtime.execute(request(), { provider: synthesizing, mode: "stream" }));
    assert.equal(outcome.type, "failed");
    assert.equal(outcome.partial.content, "cut off");

    const proven = mock("q", { traits: PROOF, stream: () => chunks({ type: "text", text: "whole" }, { type: "done" }) });
    const completed = outcomeOf(await runtime.execute(request(), { provider: proven, mode: "stream" }));
    assert.equal(completed.type, "completed");
    assert.equal(completed.finish_reason, "other");
  });

  test("a failure after partial output is reported with the partial output and the status", async () => {
    const provider = mock("p", {
      traits: PROOF,
      stream: () => chunks({ type: "text", text: "so far" }, new ProviderError("STREAM_FAILED", "reset", "p", true, { status: 503 })),
    });
    const result = await runtime.execute(request(), { provider, mode: "stream" });
    const outcome = outcomeOf(result);
    assert.equal(outcome.type, "failed");
    assert.equal(outcome.origin, "capability");
    assert.equal(outcome.kind, "provider_unavailable");
    assert.equal(outcome.status_hint, 503);
    assert.equal(outcome.delivery, "confirmed_response");
    assert.equal(outcome.partial.content, "so far");
  });

  test("malformed provider output is a protocol violation", async () => {
    const stream = mock("s", { traits: PROOF, stream: () => chunks({ type: "text", text: "x" }, { type: "mystery" }) });
    const streamed = outcomeOf(await runtime.execute(request(), { provider: stream, mode: "stream" }));
    assert.equal(streamed.kind, "protocol_violation");
    assert.equal(streamed.partial.content, "x");

    const generate = mock("g", { generate: () => ({ model: "m" }) });
    const collected = outcomeOf(await runtime.execute(request(), { provider: generate, mode: "generate" }));
    assert.equal(collected.kind, "protocol_violation");
  });

  test("tool-call proposals are data; nothing is executed", async () => {
    const provider = mock("p", {
      generate: () => ({
        text: "",
        model: "m",
        finishReason: "tool_calls",
        toolCalls: [
          { id: "call_1", name: "list_files", arguments: { path: "." } },
          { id: "call_2", name: "list_files" },
        ],
      }),
    });
    const result = await runtime.execute(request(), { provider, mode: "generate" });
    const outcome = outcomeOf(result);
    assert.equal(outcome.finish_reason, "tool_calls");
    assert.deepEqual(outcome.proposals.map((p) => [p.id, p.arguments_json]), [["call_1", '{"path":"."}'], ["call_2", "{}"]]);
    assert.deepEqual(outcome.provider_records, []);
    assert.equal(result.report.disposition, "tool_proposals");
    // The second proposal had no usable arguments: FX flags it, and admission would refuse it.
    assert.deepEqual(result.report.proposal_checks[1], { identity: "valid", integrity: "replaced", source: "missing" });
  });

  test("a budget reaches the provider layer and its timeout is reported as a timeout", async () => {
    const provider = mock("p", { generate: () => new Promise(() => {}), traits: PROOF });
    const result = await runtime.execute(request({ budget_ms: 40 }), { provider, mode: "generate" });
    const outcome = outcomeOf(result);
    assert.equal(outcome.type, "failed");
    assert.equal(outcome.kind, "timeout");
    assert.equal(outcome.delivery, "possibly_sent", "a timeout never proves the request was not sent");
  });
});

describe("cancellation and delivery", () => {
  test("cancelling before the provider is invoked sends nothing", async () => {
    const provider = mock("p", { generate: () => ({ text: "x", model: "m" }), stream: () => chunks({ type: "done" }) });
    const controller = new AbortController();
    controller.abort();
    const result = await runtime.execute(request(), { provider, signal: controller.signal });
    const outcome = outcomeOf(result);
    assert.equal(outcome.type, "cancelled");
    assert.equal(outcome.delivery, "definitely_unsent");
    assert.equal(outcome.remote, "not_started");
    assert.deepEqual([provider.calls.generate, provider.calls.stream], [0, 0]);
    assert.equal(result.report.diagnostics.starts, 0);
  });

  test("cancelling mid-stream keeps the partial output and observed delivery, and reaches the provider", async () => {
    const provider = mock("p", {
      traits: PROOF,
      stream: (req) =>
        (async function* () {
          yield { type: "text", text: "first" };
          await new Promise((resolve) => req.signal.addEventListener("abort", resolve));
          throw new DOMException("aborted", "AbortError");
        })(),
    });
    const controller = new AbortController();
    const result = await runtime.execute(request(), {
      provider,
      mode: "stream",
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === "text_delta") controller.abort();
      },
    });
    const outcome = outcomeOf(result);
    assert.equal(outcome.type, "cancelled");
    assert.equal(outcome.delivery, "confirmed_response");
    assert.equal(outcome.remote, "unconfirmed", "Easy-LLM cannot observe the transport closing");
    assert.equal(outcome.partial.content, "first");
    assert.equal(provider.calls.signals[0].aborted, true, "the abort reached the provider");
    assert.equal(result.report.diagnostics.cancels, 1);
    assert.equal(result.host.abortForwarded, true);
  });

  test("cancelling while the first event is awaited is a cancel after invocation, never an unsent request", async () => {
    const provider = mock("p", { traits: PROOF, stream: (req) => (async function* () { await new Promise((resolve) => req.signal.addEventListener("abort", resolve)); })() });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    const result = await runtime.execute(request(), { provider, mode: "stream", signal: controller.signal });
    const outcome = outcomeOf(result);
    assert.equal(outcome.type, "cancelled");
    assert.equal(outcome.delivery, "possibly_sent");
    assert.equal(outcome.remote, "unconfirmed");
    assert.equal(provider.calls.stream, 1);
  });

  test("cancelling a collected call is also a cancel after invocation", async () => {
    const provider = mock("p", { traits: PROOF, generate: (req) => new Promise((_, reject) => req.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))) });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    const outcome = outcomeOf(await runtime.execute(request(), { provider, mode: "generate", signal: controller.signal }));
    assert.equal(outcome.type, "cancelled");
    assert.equal(outcome.delivery, "possibly_sent");
  });

  test("a provider that ignores the abort cannot hold the attempt open, and the limitation is reported", async () => {
    const provider = mock("stubborn", { generate: () => new Promise(() => {}) });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    const result = await runtime.execute(request(), { provider, mode: "generate", signal: controller.signal });
    assert.equal(outcomeOf(result).type, "cancelled");
    assert.equal(result.host.abortForwarded, false, "the provider did not declare that it forwards the abort");
    assert.equal(result.host.transportRetries, "unknown", "retries inside an undeclared provider cannot be ruled out");
  });

  test("an observer that returns false abandons the attempt", async () => {
    const provider = mock("p", {
      traits: PROOF,
      stream: () => (async function* () {
        yield { type: "text", text: "one" };
        await sleep(20);
        yield { type: "text", text: "two" };
        yield { type: "done", finishReason: "stop" };
      })(),
    });
    const result = await runtime.execute(request(), { provider, mode: "stream", onEvent: () => false });
    assert.equal(outcomeOf(result).type, "cancelled");
    assert.equal(outcomeOf(result).delivery, "confirmed_response");
  });

  test("delivery only moves forward through the attempt", async () => {
    const stages = [];
    const provider = mock("p", { traits: PROOF, stream: () => chunks({ type: "text", text: "a" }, new Error("late failure")) });
    const result = await runtime.execute(request(), { provider, mode: "stream", onEvent: () => { stages.push("event"); } });
    assert.equal(outcomeOf(result).delivery, "confirmed_response");
    assert.equal(result.report.diagnostics.delivery, "confirmed_response");
    assert.deepEqual(stages, ["event"]);
  });
});

describe("security and isolation", () => {
  test("credentials and prompts do not appear in the outcome, diagnostics or host facts", async () => {
    const provider = mock("p", {
      traits: PROOF,
      stream: () => chunks({ type: "text", text: "partial" }, new ProviderError("STREAM_FAILED", `Bearer ${SECRET} was rejected`, "p", false, { status: 401 })),
    });
    const doc = request({
      messages: [{ role: "user", parts: [{ type: "text", text: `prompt ${SECRET}` }] }],
      correlation: { request_id: RID, affinity_key: `session-${SECRET}` },
    });
    const result = await runtime.execute(doc, { provider, mode: "stream" });
    const everything = JSON.stringify(result);
    assert.ok(!everything.includes(SECRET), "no secret appears anywhere in the result");
    const diagnostics = JSON.stringify(result.report.diagnostics);
    assert.ok(!diagnostics.includes("prompt") && !diagnostics.includes("session-"));
    assert.equal(outcomeOf(result).kind, "unauthenticated");
  });

  test("the module has no imports, so it holds no filesystem, process, network, clock or environment access", async () => {
    const { readFile } = await import("node:fs/promises");
    const { defaultWasmPath } = await import("../src/index.js");
    const module = await WebAssembly.compile(await readFile(defaultWasmPath()));
    assert.deepEqual(WebAssembly.Module.imports(module), []);
  });

  test("a module that asks for host imports is refused", async () => {
    // (module (import "env" "f" (func)))
    const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 2, 9, 1, 3, 101, 110, 118, 1, 102, 0, 0]);
    await assert.rejects(loadModule(bytes), (error) => error instanceof HostProtocolError && error.code === "unexpected_imports");
  });

  test("a module missing required exports is refused", async () => {
    const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
    await assert.rejects(loadModule(bytes), (error) => error instanceof HostProtocolError && error.code === "missing_exports");
  });
});
