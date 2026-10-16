// @ts-check
// The provider conformance cases. Every case runs once per applicable provider, through the
// real Easy-LLM adapter and the real Rust executor, against the local mock server.
//
// A case ends in one of three states for a provider:
//   pass        every assertion held and nothing was recorded as a limitation
//   limitation  every assertion held, and the case recorded a documented gap: the adapter
//               behaves as the note says, and the manifest must not call that feature supported
//   fail        an assertion did not hold (including: a limitation stopped being true)
//
// `features` names the manifest features a case provides evidence for.

import assert from "node:assert/strict";

import { API_KEY } from "./harness.mjs";

/** @typedef {import("./mock-providers.mjs").ProviderId} ProviderId */
/** @typedef {import("./harness.mjs").Run} Run */
/** @typedef {import("./harness.mjs").RunOptions} RunOptions */

/** The value of a field the provider or adapter does not supply: null on the wire. */
export const ABSENT = Symbol("absent");

/**
 * Subset match. Objects: every expected key must match. Arrays: same length, element-wise.
 * `ABSENT`: null or undefined. A function is a predicate.
 * @param {any} actual @param {any} expected @param {string} path @param {string[]} problems
 */
function match(actual, expected, path, problems) {
  if (expected === ABSENT) {
    if (actual !== null && actual !== undefined) problems.push(`${path}: expected none, got ${JSON.stringify(actual)}`);
  } else if (typeof expected === "function") {
    if (!expected(actual)) problems.push(`${path}: predicate failed for ${JSON.stringify(actual)}`);
  } else if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      problems.push(`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    } else expected.forEach((item, index) => match(actual[index], item, `${path}[${index}]`, problems));
  } else if (expected !== null && typeof expected === "object") {
    if (actual === null || typeof actual !== "object") problems.push(`${path}: expected an object, got ${JSON.stringify(actual)}`);
    else for (const key of Object.keys(expected)) match(actual[key], expected[key], `${path}.${key}`, problems);
  } else if (actual !== expected) {
    problems.push(`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

/** @param {any} actual @param {any} expected @param {string} [label] */
export function check(actual, expected, label = "value") {
  /** @type {string[]} */
  const problems = [];
  match(actual, expected, label, problems);
  if (problems.length > 0) assert.fail(problems.join("\n"));
}

/**
 * @typedef {object} T
 * @property {ProviderId} provider
 * @property {(table: Partial<Record<ProviderId | "default", any>>) => any} pick the value for this provider
 * @property {(scenario: string, mode: "generate" | "stream", options?: RunOptions) => Promise<Run>} run
 *   one attempt; the universal invariants are checked before it returns
 * @property {typeof check} check
 * @property {(note: string, assertions: () => void) => void} limitation assertions that describe a documented gap
 *
 * @typedef {object} Case
 * @property {string} id
 * @property {number} group which numbered behavior of the conformance spec this belongs to (0: invariants)
 * @property {string} title
 * @property {string[]} features
 * @property {readonly ProviderId[]} [providers] default: all
 * @property {(t: T) => Promise<void>} run
 */

/** The two providers whose adapters carry a finish reason (and usage) on a stream. */
const OPENAI_STYLE = ["openai", "openrouter"];

/** Event types a consumer sees, without the metadata and usage bookkeeping. */
const kinds = (/** @type {Run} */ run) => run.events.map((event) => event.type).filter((type) => type !== "metadata" && type !== "usage");

/** @param {Run} run */
const requestsOf = (run) => run.http;

const PNG = Buffer.from("\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR", "latin1").toString("base64");
const TOOL = { name: "list_files", description: "d", input_schema_json: '{"type":"object"}' };

/** Requests no adapter can carry through this path: refused before the provider is invoked. */
const UNCARRIABLE = /** @type {Array<[string, string, Record<string, unknown>]>} */ ([
  ["tool_definitions", "tool definitions", { tools: [TOOL] }],
  ["tool_definitions", "tool choice", { tools: [TOOL], tool_choice: { type: "required" } }],
  [
    "tool_call_history",
    "tool-call history",
    {
      messages: [
        { role: "user", parts: [{ type: "text", text: "run it" }] },
        { role: "assistant", parts: [{ type: "tool_call", id: "c1", name: "list_files", arguments_json: "{}" }] },
        { role: "tool", parts: [{ type: "tool_result", call_id: "c1", name: "list_files", output: { type: "text", text: "a b" } }] },
      ],
    },
  ],
  ["images", "image parts", { messages: [{ role: "user", parts: [{ type: "image", media_type: "image/png", data_base64: PNG }] }] }],
  ["generation_options", "generation options", { options: { max_output_tokens: 10 } }],
  ["structured_output", "structured output", { options: { response_format: { name: "n", description: "d", schema_json: "{}" } } }],
]);

/** The finish reason FX reports for each scenario, for providers that carry one. */
const FINISH = /** @type {Record<string, Partial<Record<ProviderId, string>>>} */ ({
  ok: { openai: "stop", openrouter: "stop", anthropic: "stop", google: "stop", ollama: "stop" },
  length: { openai: "length", openrouter: "length", anthropic: "length", google: "length", ollama: "length" },
  filter: { openai: "content_filter", openrouter: "content_filter", anthropic: "other", google: "content_filter" },
  unknown: { openai: "other", openrouter: "other", anthropic: "other", google: "other", ollama: "other" },
});

/** @type {Case[]} */
export const CASES = [
  // ------------------------------------------------------------------ 1. collected completion
  {
    id: "generate-success",
    group: 1,
    title: "a collected completion: content, finish reason, usage, delivery, credentials",
    features: ["text_generate"],
    async run(t) {
      const run = await t.run("ok", "generate");
      t.check(run.outcome, {
        type: "completed",
        content: "Hello world",
        finish_reason: "stop",
        usage: t.pick({ ollama: ABSENT, default: { input_tokens: 5, output_tokens: 2 } }),
        proposals: [],
      });
      t.check(run.report.diagnostics, { delivery: "confirmed_response", terminal: { type: "finished" } });
      assert.equal(requestsOf(run).length, 1);
      assert.deepEqual(run.host, { ...run.host, mode: "generate", providerInvoked: true, providerInvocations: 1, transportRetries: "none", abortForwarded: true });
      // The credential travels only inside the adapter's own request to its provider.
      const seen = run.http[0].headers;
      t.check(seen, t.pick({
        openai: { authorization: `Bearer ${API_KEY}` },
        openrouter: { authorization: `Bearer ${API_KEY}` },
        anthropic: { "x-api-key": API_KEY },
        default: {},
      }));
    },
  },

  // ------------------------------------------------------------------ 2. streamed completion
  {
    id: "stream-success",
    group: 2,
    title: "a streamed completion: ordered deltas, then a finish backed by provider evidence",
    features: ["text_stream"],
    async run(t) {
      const run = await t.run("ok", "stream");
      assert.equal(run.http.length, 1);
      assert.equal(run.http[0].stream, true);
      if (t.provider === "google") {
        t.limitation("the Google stream never carries terminal evidence: every streamed attempt ends interrupted, keeping its partial output", () => {
          t.check(run.outcome, {
            type: "failed",
            origin: "executor",
            kind: "transport",
            delivery: "confirmed_response",
            partial: { content: "Hello world" },
          });
          t.check(run.report.diagnostics.terminal, { type: "ended_without_finish" });
          assert.deepEqual(kinds(run), ["text_delta", "text_delta"]);
        });
        return;
      }
      t.check(run.outcome, {
        type: "completed",
        content: "Hello world",
        finish_reason: t.pick({ openai: "stop", openrouter: "stop", default: "other" }),
      });
      assert.deepEqual(kinds(run), ["text_delta", "text_delta", "finish"]);
      t.check(run.report.diagnostics, { delivery: "confirmed_response", terminal: { type: "finished" } });
    },
  },

  // ------------------------------------------------------------------ 3. empty streaming response
  {
    id: "stream-empty-body",
    group: 3,
    title: "a successful stream with no bytes is an interrupted attempt, not an empty success",
    features: ["text_stream"],
    async run(t) {
      const run = await t.run("empty-body", "stream");
      t.check(run.outcome, { type: "failed", origin: "executor", kind: "transport" });
      t.check(run.report.diagnostics.terminal, { type: "ended_without_finish" });
      assert.ok(["possibly_sent", "confirmed_response"].includes(run.outcome.delivery), `delivery ${run.outcome.delivery}`);
      assert.deepEqual(kinds(run), []);
    },
  },
  {
    id: "stream-empty-terminal",
    group: 3,
    title: "a stream with a terminal marker and no text is a verified, empty completion",
    features: ["text_stream"],
    async run(t) {
      const run = await t.run("empty-terminal", "stream");
      if (t.provider === "google") {
        t.limitation("the Google stream carries no terminal evidence, so even an empty answer ends interrupted", () => {
          t.check(run.outcome, { type: "failed", origin: "executor", kind: "transport" });
        });
        return;
      }
      t.check(run.outcome, { type: "completed", content: "", finish_reason: t.pick({ openai: "stop", openrouter: "stop", default: "other" }) });
      assert.deepEqual(kinds(run), ["finish"]);
    },
  },
  {
    id: "generate-empty-body",
    group: 3,
    title: "a collected response that is not a response (no choices, no content, no finish reason) is not a success",
    features: ["text_generate", "finish_reason_generate"],
    async run(t) {
      const run = await t.run("wrong-shape", "generate");
      t.check(run.outcome, { type: "failed", origin: "executor", kind: "transport", partial: ABSENT });
      t.check(run.report.diagnostics.terminal, { type: "ended_without_finish" });
      assert.notEqual(run.outcome.type, "completed");
    },
  },

  // ------------------------------------------------------------------ 4. provider-reported finish reasons
  {
    id: "finish-reason-generate",
    group: 4,
    title: "a collected response's finish reason maps deterministically; unknown values never become stop",
    features: ["finish_reason_generate"],
    async run(t) {
      for (const scenario of ["ok", "length", "filter", "unknown"]) {
        const expected = FINISH[scenario][t.provider];
        if (expected === undefined) continue; // this provider has no such finish reason
        const run = await t.run(scenario, "generate");
        t.check(run.outcome, { type: "completed", finish_reason: expected }, scenario);
        assert.equal(kinds(run).at(-1), "finish", scenario);
      }
      const unknown = await t.run("unknown", "generate");
      assert.notEqual(unknown.outcome.finish_reason, "stop", "an unknown finish reason must not look like normal completion");
    },
  },
  {
    id: "finish-reason-stream",
    group: 4,
    title: "a streamed finish reason is carried where the adapter carries it",
    features: ["finish_reason_stream"],
    async run(t) {
      if (OPENAI_STYLE.includes(t.provider)) {
        for (const scenario of ["ok", "length", "filter", "unknown"]) {
          const run = await t.run(scenario, "stream");
          t.check(run.outcome, { type: "completed", finish_reason: FINISH[scenario][t.provider] }, scenario);
        }
        return;
      }
      if (t.provider === "google") {
        t.limitation("the Google stream carries no finish reason and no terminal evidence", () => {});
        for (const scenario of ["ok", "length", "filter", "unknown"]) {
          const run = await t.run(scenario, "stream");
          t.check(run.outcome, { type: "failed", origin: "executor" }, scenario);
        }
        return;
      }
      // Anthropic and Ollama end the stream on the provider's own marker but do not carry its reason.
      /** @type {string[]} */
      const scenarios = t.provider === "anthropic" ? ["ok", "length", "filter", "unknown"] : ["ok", "length", "unknown"];
      t.limitation("the adapter ends the stream on the provider's terminal marker but does not carry the provider's finish reason", () => {});
      for (const scenario of scenarios) {
        const run = await t.run(scenario, "stream");
        t.check(run.outcome, { type: "completed", finish_reason: "other" }, scenario);
      }
    },
  },

  // ------------------------------------------------------------------ 5. termination without a verified finish
  {
    id: "stream-no-finish",
    group: 5,
    title: "a stream that ends without verified completion stays interrupted and keeps its partial output",
    features: ["text_stream"],
    async run(t) {
      const run = await t.run("no-finish", "stream");
      t.check(run.outcome, { type: "failed", origin: "executor", kind: "transport", delivery: "confirmed_response", partial: { content: "cut off" } });
      t.check(run.report.diagnostics.terminal, { type: "ended_without_finish" });
      assert.notEqual(run.report.diagnostics.terminal.type, "finished");
      assert.deepEqual(kinds(run), ["text_delta", "text_delta"]);
    },
  },
  {
    id: "generate-no-finish",
    group: 5,
    title: "a collected response without a finish reason is interrupted, not completed with an invented one",
    features: ["finish_reason_generate"],
    async run(t) {
      const run = await t.run("no-finish", "generate");
      t.check(run.outcome, { type: "failed", origin: "executor", kind: "transport", partial: { content: "cut off" } });
      t.check(run.report.diagnostics.terminal, { type: "ended_without_finish" });
      assert.ok(!run.events.some((event) => event.type === "finish"), "no finish event was manufactured");
    },
  },

  // ------------------------------------------------------------------ 6. HTTP errors
  {
    id: "http-status",
    group: 6,
    title: "the HTTP status reaches FX and decides the category, never the message text",
    features: ["http_status"],
    async run(t) {
      /** @type {Array<[string, string, number]>} */
      const table = [
        ["http-401", "unauthenticated", 401],
        ["http-403", "forbidden", 403],
        ["http-404", "model_unavailable", 404],
        ["http-429-no-retry", "rate_limited", 429],
        ["http-500", "provider_unavailable", 500],
        ["http-502-html", "provider_unavailable", 502],
      ];
      for (const mode of /** @type {const} */ (["generate", "stream"])) {
        for (const [scenario, kind, status] of table) {
          const run = await t.run(scenario, mode);
          t.check(run.outcome, { type: "failed", origin: "capability", kind, status_hint: status, delivery: "possibly_sent" }, `${scenario} ${mode}`);
          assert.equal(run.http.length, 1, `${scenario} ${mode}: one request, no retry`);
          t.check(run.report.diagnostics.terminal, { type: "start_failed" }, `${scenario} ${mode}`);
        }
      }
    },
  },
  {
    id: "http-retry-after",
    group: 6,
    title: "Retry-After in seconds reaches FX; an unusable value is dropped, not guessed",
    features: ["retry_after"],
    async run(t) {
      for (const mode of /** @type {const} */ (["generate", "stream"])) {
        const given = await t.run("http-429", mode);
        t.check(given.outcome, { type: "failed", kind: "rate_limited", status_hint: 429, retry_after_ms: 3000, delivery: "possibly_sent" }, mode);
        for (const scenario of ["http-429-bad-retry", "http-429-no-retry"]) {
          const run = await t.run(scenario, mode);
          t.check(run.outcome, { type: "failed", kind: "rate_limited", status_hint: 429, retry_after_ms: ABSENT }, `${scenario} ${mode}`);
        }
      }
    },
  },
  {
    id: "http-error-single-attempt",
    group: 6,
    title: "a rate limit or a server error is not retried, redirected or fallen back from",
    features: ["http_status"],
    async run(t) {
      for (const scenario of ["http-429", "http-500"]) {
        for (const mode of /** @type {const} */ (["generate", "stream"])) {
          const run = await t.run(scenario, mode);
          assert.equal(run.http.length, 1, `${scenario} ${mode}`);
          assert.equal(run.host.providerInvocations, 1, `${scenario} ${mode}`);
          t.check(run.outcome, { type: "failed" });
        }
      }
    },
  },

  // ------------------------------------------------------------------ 7. malformed responses
  {
    id: "malformed-collected-response",
    group: 7,
    title: "a collected response that is not JSON fails; it is never a completion",
    features: ["text_generate"],
    async run(t) {
      const run = await t.run("not-json", "generate");
      t.check(run.outcome, { type: "failed", origin: "capability", kind: "transport", delivery: "possibly_sent", status_hint: ABSENT });
      assert.equal(run.http.length, 1);
    },
  },
  {
    id: "malformed-stream-lines",
    group: 7,
    title: "unparseable stream lines never surface as output and never create a terminal",
    features: ["malformed_chunks_reported"],
    async run(t) {
      const run = await t.run("garbage", "stream");
      assert.ok(!JSON.stringify(run.events).includes("nope"), "malformed input leaked into the events");
      if (t.provider === "google") {
        t.limitation("the Google stream never completes", () => t.check(run.outcome, { type: "failed", origin: "executor" }));
        return;
      }
      if (t.provider === "ollama") {
        // Ollama's client parses each line without a guard: a malformed line fails the attempt.
        t.check(run.outcome, { type: "failed", origin: "capability", kind: "transport" });
        assert.notEqual(run.outcome.type, "completed");
        return;
      }
      // The other clients skip a line they cannot parse. The attempt still needs its terminal evidence.
      t.limitation("the adapter silently skips a stream line it cannot parse; text carried only by such a line is lost without a signal", () => {
        t.check(run.outcome, { type: "completed", content: "a b" });
      });
    },
  },

  // ------------------------------------------------------------------ 8. failure before a request is sent
  {
    id: "connect-refused",
    group: 8,
    title: "a refused connection is a transport failure that stays possibly sent; fetch cannot prove nothing left the host",
    features: [],
    async run(t) {
      for (const mode of /** @type {const} */ (["generate", "stream"])) {
        const run = await t.run("ok", mode, { dead: true });
        t.check(run.outcome, { type: "failed", origin: "capability", kind: "transport", delivery: "possibly_sent", status_hint: ABSENT }, mode);
        assert.equal(run.http.length, 0, "nothing reached the mock server");
        assert.equal(run.host.providerInvoked, true, "the provider layer was called");
        assert.equal(run.host.providerInvocations, 1);
      }
    },
  },
  {
    id: "invalid-request-before-dispatch",
    group: 8,
    title: "requests that fail FX validation never reach the provider",
    features: [],
    async run(t) {
      const bad = [
        ["empty model", { model: "" }],
        ["unsupported version", { v: 2 }],
        ["no messages", { messages: [] }],
        ["unknown field", { mystery: true }],
      ];
      for (const [label, fields] of /** @type {Array<[string, Record<string, unknown>]>} */ (bad)) {
        for (const mode of /** @type {const} */ (["generate", "stream"])) {
          const run = await t.run("ok", mode, { request: fields });
          assert.equal(run.outcome.type, "failed", `${label} ${mode}`);
          assert.equal(run.outcome.origin, "executor", `${label} ${mode}`);
          assert.equal(run.outcome.delivery, "definitely_unsent", `${label} ${mode}`);
          assert.equal(run.http.length, 0, `${label} ${mode}`);
          assert.equal(run.host.providerInvoked, false, `${label} ${mode}`);
        }
      }
    },
  },
  {
    id: "aborted-before-dispatch",
    group: 8,
    title: "an attempt cancelled before the provider is invoked is definitely unsent",
    features: ["cancellation"],
    async run(t) {
      for (const mode of /** @type {const} */ (["generate", "stream"])) {
        const controller = new AbortController();
        controller.abort();
        const run = await t.run("ok", mode, { signal: controller.signal });
        t.check(run.outcome, { type: "cancelled", delivery: "definitely_unsent", remote: "not_started" }, mode);
        assert.equal(run.http.length, 0, mode);
        assert.equal(run.host.providerInvoked, false, mode);
      }
    },
  },

  // ------------------------------------------------------------------ 9. failure after invocation
  {
    id: "reset-before-response",
    group: 9,
    title: "a connection dropped after the request, before any response, is possibly sent",
    features: [],
    async run(t) {
      for (const mode of /** @type {const} */ (["generate", "stream"])) {
        const run = await t.run("reset-before-response", mode);
        t.check(run.outcome, { type: "failed", origin: "capability", kind: "transport", delivery: "possibly_sent", status_hint: ABSENT }, mode);
        assert.equal(run.http.length, 1, mode);
      }
    },
  },
  {
    id: "reset-mid-stream",
    group: 9,
    title: "a connection dropped mid-stream keeps the partial output and confirms the response",
    features: ["text_stream"],
    async run(t) {
      const run = await t.run("reset-mid-stream", "stream");
      t.check(run.outcome, {
        type: "failed",
        origin: "capability",
        kind: "transport",
        delivery: "confirmed_response",
        status_hint: ABSENT,
        partial: { content: "part " },
      });
      assert.notEqual(run.report.diagnostics.terminal.type, "finished");
    },
  },

  // ------------------------------------------------------------------ 10. cancellation and late events
  {
    id: "cancel-before-response",
    group: 10,
    title: "cancelling a pending request closes the connection; it is cancelled after invocation, never unsent",
    features: ["cancellation"],
    async run(t) {
      for (const mode of /** @type {const} */ (["generate", "stream"])) {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 60);
        const run = await t.run("hang", mode, { signal: controller.signal, expectClose: true });
        t.check(run.outcome, { type: "cancelled", delivery: "possibly_sent", remote: "unconfirmed" }, mode);
        assert.equal(run.http.length, 1, mode);
        assert.equal(run.closed, 1, `${mode}: the server saw the client drop the connection`);
        assert.equal(run.host.abortForwarded, true);
      }
    },
  },
  {
    id: "cancel-mid-stream",
    group: 10,
    title: "cancelling mid-stream stops the attempt; what the provider writes afterwards changes nothing",
    features: ["cancellation", "text_stream"],
    async run(t) {
      const controller = new AbortController();
      let after = 0;
      let cancelled = false;
      const run = await t.run("drip", "stream", {
        signal: controller.signal,
        settle: 150,
        expectClose: true,
        onEvent: (event) => {
          if (cancelled) after += 1;
          if (event.type === "text_delta" && !cancelled) {
            cancelled = true;
            controller.abort();
          }
        },
      });
      t.check(run.outcome, { type: "cancelled", delivery: "confirmed_response" });
      assert.notEqual(run.outcome.remote, "confirmed", "cancelling never proves the remote operation stopped");
      assert.equal(run.closed, 1, "the server saw the client drop the connection");
      assert.equal(after, 0, `${after} events were forwarded after the cancel`);
      assert.ok(run.events.every((event) => event.type === "text_delta"), "only deltas seen before the cancel");
    },
  },
  {
    id: "attempt-budget",
    group: 10,
    title: "the attempt budget cancels the request and is a timeout, possibly sent",
    features: ["cancellation"],
    async run(t) {
      for (const mode of /** @type {const} */ (["generate", "stream"])) {
        const run = await t.run("hang", mode, { budget: 80, expectClose: true });
        t.check(run.outcome, { type: "failed", kind: "timeout", delivery: "possibly_sent" }, mode);
        assert.equal(run.closed, 1, `${mode}: the request was aborted`);
      }
    },
  },
  {
    id: "abandon-from-observer",
    group: 10,
    title: "an observer that returns false abandons the attempt; the request is closed",
    features: ["cancellation"],
    async run(t) {
      const run = await t.run("drip", "stream", { onEvent: () => false, settle: 100, expectClose: true });
      t.check(run.outcome, { type: "cancelled" });
      assert.equal(run.closed, 1);
      assert.equal(run.events.length, 1, "nothing was forwarded after the observer stopped the attempt");
    },
  },
  {
    id: "late-chunks-after-terminal",
    group: 10,
    title: "output written after the provider's terminal marker does not change the outcome",
    features: ["late_events_ignored"],
    async run(t) {
      const run = await t.run("late", "stream");
      if (t.provider === "google") {
        t.limitation("the Google stream has no terminal marker, so there is no point after which output counts as late", () => {
          t.check(run.outcome, { type: "failed", origin: "executor" });
        });
        return;
      }
      if (OPENAI_STYLE.includes(t.provider)) {
        // The adapter reads to the end of input and only then yields its `done`: text after [DONE] is output.
        t.limitation("the adapter keeps reading after the provider's terminal marker, so text sent after it joins the output", () => {
          t.check(run.outcome, { type: "completed", content: "a LATE" });
        });
        return;
      }
      t.check(run.outcome, { type: "completed", content: "a " });
      assert.ok(!JSON.stringify(run.events).includes("LATE"));
    },
  },

  // ------------------------------------------------------------------ 11. usage metadata
  {
    id: "usage-generate",
    group: 11,
    title: "usage on a collected response: carried, partly carried, or dropped; never corrupting the outcome",
    features: ["usage_generate"],
    async run(t) {
      const ok = await t.run("ok", "generate");
      const partial = await t.run("usage-partial", "generate");
      const invalid = await t.run("usage-invalid", "generate");
      const none = await t.run("usage-none", "generate");
      for (const run of [ok, partial, invalid, none]) t.check(run.outcome, { type: "completed", finish_reason: "stop" });
      t.check(none.outcome, { usage: ABSENT });
      t.check(invalid.outcome, { usage: ABSENT });
      if (t.provider === "ollama") {
        t.limitation("the Ollama client does not read token counts from the response", () => {
          t.check(ok.outcome, { usage: ABSENT });
          t.check(partial.outcome, { usage: ABSENT });
        });
        return;
      }
      t.check(ok.outcome, { usage: { input_tokens: 5, output_tokens: 2 } });
      // Only the valid field survives; the invalid one is omitted, not repaired or zeroed.
      t.check(partial.outcome, { usage: { input_tokens: 5, output_tokens: ABSENT } });
    },
  },
  {
    id: "usage-stream",
    group: 11,
    title: "usage on a stream: carried only where the adapter reads it; missing or invalid usage never invalidates a verified completion",
    features: ["usage_stream"],
    async run(t) {
      if (t.provider === "google") {
        t.limitation("the Google stream never completes, so no completed attempt carries usage", () => {});
        const run = await t.run("ok", "stream");
        t.check(run.outcome, { type: "failed", origin: "executor" });
        return;
      }
      const ok = await t.run("ok", "stream");
      const invalid = await t.run("usage-invalid", "stream");
      const none = await t.run("usage-none", "stream");
      for (const run of [ok, invalid, none]) t.check(run.outcome, { type: "completed" });
      t.check(invalid.outcome, { usage: ABSENT });
      t.check(none.outcome, { usage: ABSENT });
      if (OPENAI_STYLE.includes(t.provider)) {
        // The adapter reads a usage chunk when the provider sends one. Its request does not ask for one
        // (no stream_options), so whether a live provider sends it is not established here.
        t.check(ok.outcome, { usage: { input_tokens: 5, output_tokens: 2 } });
        assert.equal(ok.http[0].body.stream_options, undefined, "the adapter does not ask for streamed usage");
        t.limitation("usage is parsed when sent, but the request does not ask the provider to send it", () => {});
        return;
      }
      t.limitation("the adapter does not carry usage from a stream", () => {
        t.check(ok.outcome, { usage: ABSENT });
      });
    },
  },

  // ------------------------------------------------------------------ 12. exactly one invocation
  {
    id: "single-invocation",
    group: 12,
    title: "every kind of attempt makes exactly one provider request: success, error, reset, timeout, cancel",
    features: [],
    async run(t) {
      /** @type {Array<[string, RunOptions]>} */
      const attempts = [
        ["ok", {}],
        ["http-429", {}],
        ["http-500", {}],
        ["not-json", {}],
        ["no-finish", {}],
        ["reset-before-response", {}],
        ["hang", { budget: 60 }],
      ];
      for (const [scenario, options] of attempts) {
        for (const mode of /** @type {const} */ (["generate", "stream"])) {
          const run = await t.run(scenario, mode, options);
          assert.equal(run.http.length, 1, `${scenario} ${mode}: provider requests`);
          assert.equal(run.host.providerInvocations, 1, `${scenario} ${mode}: Easy-LLM reports invocations`);
        }
      }
      // No second request is started later (a delayed retry would show up here).
      const after = await t.run("ok", "generate", { settle: 100 });
      assert.equal(after.http.length, 1);
    },
  },

  // ------------------------------------------------------------------ 0. FX invariants over provider output
  {
    id: "provider-claims-do-not-decide-the-outcome",
    group: 0,
    title: "a provider that says it stopped for tool calls, without returning any, does not get a valid completion",
    features: [],
    providers: ["openai", "openrouter", "anthropic"],
    async run(t) {
      for (const mode of /** @type {const} */ (["generate", "stream"])) {
        const run = await t.run("claims-tools", mode);
        // Streamed Anthropic does not carry the reason; the claim only exists where the adapter passes it on.
        if (t.provider === "anthropic" && mode === "stream") continue;
        t.check(run.outcome, { finish_reason: "tool_calls", proposals: [] }, mode);
        assert.equal(run.report.disposition, "invalid_completion", `${mode}: the executor decides, not the provider's finish reason`);
      }
    },
  },
  {
    id: "tool-proposals-are-data",
    group: 0,
    title: "a tool call the provider returns is a proposal in the report; FX does not run it or accept it unoffered",
    features: [],
    providers: ["openai", "openrouter", "anthropic", "google"],
    async run(t) {
      const run = await t.run("tool-call", "generate");
      t.check(run.outcome, { type: "completed", proposals: (/** @type {any[]} */ p) => p.length === 1 && p[0].name === "rm" });
      // The request offered no tool, so the proposal is invalid and the disposition says so.
      assert.equal(run.report.disposition, "invalid_completion");
      assert.deepEqual(run.report.diagnostics.request_shape.tools, 0);
      assert.equal(run.http.length, 1, "no follow-up provider call was made for the proposal");
    },
  },
];

/** What the FX path says about each request feature it cannot carry, one case per manifest feature. */
const REFUSAL_FEATURES = /** @type {Record<string, string>} */ ({
  tool_definitions: "tool definitions (and tool choice) are refused before dispatch: the FX path cannot offer a provider any tool",
  tool_call_history: "tool-call history is refused before dispatch: the FX path cannot replay assistant tool calls or tool results",
  images: "image parts are refused before dispatch: the FX path carries text only",
  generation_options: "generation options are refused before dispatch: the FX path transports none",
  structured_output: "structured output is refused before dispatch: the FX path cannot request it",
});

for (const [feature, note] of Object.entries(REFUSAL_FEATURES)) {
  CASES.push({
    id: `refused-${feature.replaceAll("_", "-")}`,
    group: 8,
    title: `a request using ${feature.replaceAll("_", " ")} is refused as definitely unsent, before any provider request`,
    features: [feature],
    async run(t) {
      for (const [, label, fields] of UNCARRIABLE.filter(([name]) => name === feature)) {
        for (const mode of /** @type {const} */ (["generate", "stream"])) {
          const run = await t.run("ok", mode, { request: fields });
          t.check(run.outcome, { type: "failed", kind: "capability_unavailable", delivery: "definitely_unsent" }, `${label} ${mode}`);
          t.check(run.report.diagnostics.terminal, { type: "start_failed" }, `${label} ${mode}`);
          assert.equal(run.http.length, 0, `${label} ${mode}: a provider request was made`);
          assert.equal(run.host.providerInvoked, false, `${label} ${mode}`);
        }
      }
      t.limitation(note, () => {});
    },
  });
}
