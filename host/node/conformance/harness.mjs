// @ts-check
// The conformance harness: one real Easy-LLM adapter per provider, a local mock server for
// its wire format, and the real Rust executor (WebAssembly) in between. Nothing here
// replaces an adapter's parsing or terminal-state logic.

import assert from "node:assert/strict";

import { createFxRuntime } from "../src/index.js";
import { startProviderMocks } from "./mock-providers.mjs";
import { SCENARIOS } from "./scenarios.mjs";

/** @typedef {import("./mock-providers.mjs").ProviderId} ProviderId */

/** @type {readonly ProviderId[]} */
export const PROVIDERS = Object.freeze(["openai", "openrouter", "anthropic", "google", "ollama"]);

/** A fake key with the shape of a real one. It must appear only in requests to the (mock) provider. */
export const API_KEY = "sk-CONFORMANCE-KEY-0123456789abcdef";
export const REQUEST_ID = "00112233445566778899aabbccddeeff";

/**
 * @typedef {object} Run
 * @property {import("../src/index.js").ExecuteResult} result
 * @property {Record<string, any>} outcome
 * @property {Record<string, any>} report
 * @property {Record<string, any>[]} events every normalized FX event forwarded
 * @property {import("../src/index.js").HostInfo} host
 * @property {import("./mock-providers.mjs").Seen[]} http provider requests the mock server saw during this run
 * @property {number} closed how many of this run's provider requests the client closed before the server finished
 *   (only settled when the run set `expectClose`)
 *
 * @typedef {object} RunOptions
 * @property {AbortSignal} [signal]
 * @property {number} [budget]  the FX attempt budget in ms
 * @property {Record<string, unknown>} [request]  fields merged over the request document
 * @property {(event: Record<string, any>) => void | boolean} [onEvent]
 * @property {boolean} [dead]  point the adapter at a closed port
 * @property {number} [settle]  ms to wait after the run, so late provider writes would be seen
 * @property {boolean} [expectClose]  wait (bounded) for the server to notice the client dropped the connection
 */

/** @param {string} id @param {string} baseUrl @param {typeof import("@easy-llm/llm")} easyLlm */
function createAdapter(id, baseUrl, easyLlm) {
  switch (id) {
    case "openai":
      return easyLlm.createOpenAIAdapter(API_KEY, baseUrl);
    case "openrouter":
      return easyLlm.createOpenRouterAdapter(API_KEY, baseUrl);
    case "anthropic":
      return easyLlm.createAnthropicAdapter(API_KEY, baseUrl);
    case "google":
      return easyLlm.createGoogleAdapter(API_KEY, baseUrl);
    case "ollama":
      return easyLlm.createOllamaAdapter(baseUrl);
    default:
      throw new Error(`unknown provider ${id}`);
  }
}

const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object} options
 * @param {typeof import("@easy-llm/llm")} options.easyLlm
 * @param {string | URL | Uint8Array} [options.wasm]
 */
export async function createHarness({ easyLlm, wasm }) {
  const mocks = await startProviderMocks(SCENARIOS);
  const runtime = await createFxRuntime({ easyLlm, ...(wasm && { wasm }) });
  /** @type {Map<string, any>} */
  const adapters = new Map();
  /** @param {string} id @param {boolean} dead */
  const adapterFor = (id, dead) => {
    const key = `${id}:${dead}`;
    if (!adapters.has(key)) {
      const base = dead ? mocks.deadBase(/** @type {ProviderId} */ (id)) : mocks.base(/** @type {ProviderId} */ (id));
      adapters.set(key, createAdapter(id, base, easyLlm));
    }
    return adapters.get(key);
  };

  /**
   * @param {ProviderId} provider
   * @param {string} scenario the model name, which selects what the mock does
   * @param {"generate" | "stream"} mode
   * @param {RunOptions} [options]
   * @returns {Promise<Run>}
   */
  async function run(provider, scenario, mode, options = {}) {
    const requestsBefore = mocks.requests.length;
    const document = {
      v: 1,
      model: scenario,
      messages: [{ role: "user", parts: [{ type: "text", text: "say hi" }] }],
      correlation: { request_id: REQUEST_ID },
      ...(options.budget !== undefined && { budget_ms: options.budget }),
      ...options.request,
    };
    const result = await runtime.execute(document, {
      provider: adapterFor(provider, options.dead === true),
      mode,
      ...(options.signal && { signal: options.signal }),
      ...(options.onEvent && { onEvent: options.onEvent }),
    });
    if (options.settle) await sleep(options.settle);
    const http = mocks.requests.slice(requestsBefore);
    if (options.expectClose) {
      const until = Date.now() + 2000;
      while (!http.every((seen) => seen.closed) && Date.now() < until) await sleep(5);
    }
    return {
      result,
      outcome: result.report.outcome,
      report: result.report,
      events: result.events,
      host: result.host,
      http,
      closed: http.filter((seen) => seen.closed).length,
    };
  }

  return { run, runtime, mocks, close: () => mocks.close() };
}

/**
 * Invariants that hold for every attempt on every provider, checked after each run.
 * A case never has to remember them; a run that breaks one fails the case.
 * @param {Run} run
 * @param {string} label
 */
export function checkInvariants(run, label) {
  const { outcome, report, events, http, host } = run;
  assert.ok(http.length <= 1, `${label}: ${http.length} provider requests for one attempt`);
  if (host.providerInvocations !== undefined) {
    assert.ok(host.providerInvocations <= 1, `${label}: Easy-LLM reports ${host.providerInvocations} invocations`);
  }
  // A request reached the network, so "definitely unsent" can never be the answer.
  if (http.length > 0) {
    assert.notEqual(report.diagnostics.delivery, "definitely_unsent", `${label}: delivery lowered after a request was made`);
    if ("delivery" in outcome) assert.notEqual(outcome.delivery, "definitely_unsent", `${label}: outcome delivery lowered`);
    assert.equal(host.providerInvoked, true, `${label}: a request was made but the host reports no invocation`);
  }
  if (outcome.type === "completed") {
    assert.equal(report.diagnostics.terminal.type, "finished", `${label}: completed without a verified finish`);
  }
  // At most one finish, nothing after it, and none unless the attempt completed.
  const finishes = events.filter((event) => event.type === "finish").length;
  assert.ok(finishes <= 1, `${label}: ${finishes} finish events`);
  if (finishes === 1) {
    assert.equal(events.at(-1)?.type, "finish", `${label}: events after the finish`);
    assert.equal(outcome.type, "completed", `${label}: a finish event but the attempt is ${outcome.type}`);
  }
  assert.ok(!JSON.stringify(run.result).includes(API_KEY), `${label}: the API key appears in the FX result`);
}
