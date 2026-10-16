// @ts-check
// The FX runtime for Node: one entry point that runs an FX request through the Rust
// executor (WebAssembly) against an explicitly chosen Easy-LLM provider.
//
//   FX request bytes
//     -> WebAssembly session: decode + validate (fx-core)          provider never invoked on failure
//     -> provider invoked once through Easy-LLM generateOnce / streamOnce
//     -> results fed back; fx_core::Execution normalizes, bounds and ends the attempt
//     -> one FX report
//
// This file schedules and translates. It does not validate, normalize, retry, route or
// choose a provider, and it never executes tools.

import { loadModule, SupportFlags, HostProtocolError } from "./wasm.js";
import { toSingleAttemptRequest, resultToEvents, eventsToCommands, failureDoc } from "./translate.js";

export { SupportFlags, HostProtocolError };

/**
 * @typedef {import("@easy-llm/llm").LLMProvider} LLMProvider
 * @typedef {import("@easy-llm/llm").SingleAttemptStreamEvent} StreamEvent
 * @typedef {{ generateOnce: typeof import("@easy-llm/llm").generateOnce, streamOnce: typeof import("@easy-llm/llm").streamOnce }} EasyLlm
 *
 * @typedef {object} ExecuteOptions
 * @property {LLMProvider | string} provider the provider to invoke. Required: nothing here selects one.
 *   A string is the id of a provider already registered with Easy-LLM.
 * @property {"stream" | "generate"} [mode] `stream` uses streamOnce, `generate` uses generateOnce. Defaults
 *   to `stream` for a provider object that has a `stream` operation and `generate` otherwise; required
 *   for a provider id. The choice is made once from the provider's shape and never changes after a failure.
 * @property {AbortSignal} [signal] cancels the attempt
 * @property {(event: Record<string, any>) => void | boolean} [onEvent] receives each normalized FX event in
 *   order, before the report. Returning `false` abandons the attempt (it is cancelled).
 *
 * @typedef {object} HostInfo
 * @property {string} mode
 * @property {boolean} providerInvoked whether the provider layer was called
 * @property {string} [providerId]
 * @property {"none" | "unknown"} [transportRetries] what the provider declared about its own retries
 * @property {boolean} [abortForwarded] whether the provider forwards the abort signal to its transport
 *
 * @typedef {object} ExecuteResult
 * @property {Record<string, any>} report the FX report: outcome, proposal_checks, disposition, diagnostics
 * @property {Record<string, any>[]} events every normalized FX event forwarded, in order
 * @property {HostInfo} host content-free facts about the provider call
 */

/**
 * @param {unknown} request
 * @returns {Uint8Array}
 */
function requestBytes(request) {
  if (request instanceof Uint8Array) return request;
  if (typeof request === "string") return new TextEncoder().encode(request);
  return new TextEncoder().encode(JSON.stringify(request));
}

/** @param {Record<string, any>} response @param {string} expected */
function expectStatus(response, expected) {
  if (response.status !== expected) {
    const code = response.error?.code ?? "unexpected_status";
    throw new HostProtocolError(code, `expected ${expected}, the module answered ${response.status}`);
  }
}

/**
 * Where the `wasm` build is when working inside this repository.
 * @returns {URL}
 */
export function defaultWasmPath() {
  return new URL("../../../rust/fx-host/target/wasm32-unknown-unknown/release/fx_host.wasm", import.meta.url);
}

/**
 * Creates a runtime. Compile once, execute many times; each `execute` is an independent attempt.
 *
 * @param {object} [options]
 * @param {string | URL | Uint8Array | ArrayBuffer} [options.wasm] the module; defaults to the repository build
 * @param {EasyLlm} [options.easyLlm] the Easy-LLM single-attempt functions; defaults to `@easy-llm/llm`
 * @returns {Promise<FxRuntime>}
 */
export async function createFxRuntime(options = {}) {
  const module = await loadModule(options.wasm ?? defaultWasmPath());
  const easyLlm = options.easyLlm ?? (await import("@easy-llm/llm"));
  if (typeof easyLlm.generateOnce !== "function" || typeof easyLlm.streamOnce !== "function") {
    throw new TypeError("easyLlm must provide generateOnce and streamOnce (an Easy-LLM build that includes the single-attempt API)");
  }
  return new FxRuntime(module, easyLlm);
}

export class FxRuntime {
  #module;
  #easyLlm;

  /**
   * @param {import("./wasm.js").FxModule} module
   * @param {EasyLlm} easyLlm
   */
  constructor(module, easyLlm) {
    this.#module = module;
    this.#easyLlm = easyLlm;
  }

  /**
   * Runs one FX request. Resolves with the FX report for every provider, timeout,
   * cancellation and validation outcome; it rejects only for host programming errors
   * (no provider given, a protocol violation by the module).
   *
   * @param {Uint8Array | string | object} request an FX request document (bytes are used exactly as given)
   * @param {ExecuteOptions} options
   * @returns {Promise<ExecuteResult>}
   */
  async execute(request, options) {
    const { provider, signal, onEvent } = options ?? {};
    if (provider === undefined || provider === null) {
      throw new TypeError("execute requires an explicit provider; the runtime never selects one");
    }
    const mode = options.mode ?? (typeof provider === "object" && typeof provider.stream === "function" ? "stream" : undefined);
    if (mode !== "stream" && mode !== "generate") {
      throw new TypeError('execute requires mode "stream" or "generate" when the provider is an id or has no stream operation');
    }

    const session = this.#module.newSession(0);
    /** @type {Record<string, any>[]} */
    const events = [];
    /** @type {HostInfo} */
    const host = { mode, providerInvoked: false };
    if (typeof provider === "object") {
      const traits = provider.attemptTraits;
      host.providerId = provider.id;
      host.transportRetries = traits?.transportRetries ?? "unknown";
      host.abortForwarded = traits?.abortSignal === true;
    }
    const controller = new AbortController();
    let cancelRequested = false;
    let cancelSent = false;
    /** @type {(value: "aborted") => void} */
    let resolveAbort = () => {};
    const aborted = new Promise((resolve) => (resolveAbort = resolve));
    const onAbort = () => {
      cancelRequested = true;
      controller.abort();
      resolveAbort("aborted");
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });

    /** @type {AsyncIterator<StreamEvent> | undefined} */
    let iterator;
    /** @param {Record<string, any>} response */
    const emit = (response) => {
      for (const event of response.events ?? []) {
        events.push(event);
        if (onEvent?.(event) === false && !cancelRequested) onAbort();
      }
    };
    /** @param {Record<string, any>} response @returns {ExecuteResult} */
    const finish = (response) => {
      emit(response);
      // The executor cancelled the capability: stop the provider call as well.
      if (response.abort) controller.abort();
      return { report: response.report, events, host };
    };
    /** @param {Record<string, unknown>} command */
    const send = (command) => {
      const response = session.command(command);
      if (response.status === "error") throw new HostProtocolError(response.error?.code ?? "error", response.error?.message ?? "the module rejected a command");
      return response;
    };

    try {
      let response = session.begin(requestBytes(request));
      if (response.status === "done") return finish(response);
      expectStatus(response, "need_invoke");

      // A cancel before the provider is invoked sends nothing: the module ends the attempt
      // as Cancelled { definitely_unsent, not_started }.
      if (cancelRequested) {
        send({ cmd: "cancel" });
        return finish(send({ cmd: "step" }));
      }

      // Invoke the provider once. The first provider event says whether the call was made.
      const providerRequest = toSingleAttemptRequest(response.request, controller.signal, response.timeout_ms);
      host.providerInvoked = true; // set false below if Easy-LLM reports it never called the provider
      /** @type {() => Promise<StreamEvent[] | null>} */
      let next;
      if (mode === "stream") {
        iterator = this.#easyLlm.streamOnce(provider, providerRequest)[Symbol.asyncIterator]();
        const it = iterator;
        next = async () => {
          const step = await it.next();
          return step.done ? null : [step.value];
        };
      } else {
        let pending = this.#easyLlm.generateOnce(provider, providerRequest).then(resultToEvents);
        next = async () => {
          const events = await pending;
          pending = Promise.resolve(/** @type {StreamEvent[]} */ ([]));
          return events.length > 0 ? events : null;
        };
      }

      /** @type {() => Promise<StreamEvent[] | null>} */
      const guarded = async () => {
        try {
          return await next();
        } catch (error) {
          // Easy-LLM's operations return failures as values; a throw is a bug in the provider
          // layer. Report it as a provider failure after the call was made.
          const message = error instanceof Error ? error.message : String(error);
          return [{ type: "failed", ok: false, attempt: { providerId: "", model: "", providerInvocations: 1, transportRetries: "unknown", abortForwarded: false, toolHandlerCallsBlocked: 0 }, failure: { kind: "provider_error", message, delivery: "invoked", issues: [] } }];
        }
      };

      /** @param {StreamEvent[]} batch */
      const observeHost = (batch) => {
        for (const event of batch) {
          const attempt = event.type === "done" || event.type === "failed" ? event.attempt : undefined;
          if (!attempt) continue;
          host.providerInvoked = attempt.providerInvocations > 0;
          if (attempt.providerId) host.providerId = attempt.providerId;
          host.transportRetries = attempt.transportRetries;
          host.abortForwarded = attempt.abortForwarded;
        }
      };

      // The provider layer is exhausted once it has delivered a terminal event (done or failed)
      // or has nothing left to yield.
      let exhausted = false;
      /** @param {StreamEvent[]} batch */
      const feed = (batch) => {
        observeHost(batch);
        for (const command of eventsToCommands(batch)) send(command);
        if (batch.some((event) => event.type === "done" || event.type === "failed")) exhausted = true;
      };

      const first = (await guarded()) ?? [];
      const head = first[0];
      // The caller aborted while the first event was awaited and the provider layer reports the
      // abort: the call was made, so this is a cancel after invocation, not a failed start.
      const abortedAfterInvoke =
        cancelRequested && head?.type === "failed" && head.failure.kind === "aborted" && head.failure.delivery !== "not_invoked";
      if (abortedAfterInvoke) {
        observeHost(first);
        send({ cmd: "invoke_result", ok: true });
        exhausted = true;
      } else if (head?.type === "failed" && head.failure.delivery !== "output_observed" && head.failure.kind !== "incomplete_stream") {
        // The call failed before any output: that is the invocation result.
        observeHost(first);
        host.providerInvoked = head.failure.delivery !== "not_invoked";
        send({ cmd: "invoke_result", ok: false, failure: failureDoc(head.failure) });
        exhausted = true;
      } else {
        send({ cmd: "invoke_result", ok: true });
        feed(first);
        if (first.length === 0) exhausted = true;
      }

      let closed = false;
      for (;;) {
        // A cancel is sent only after the invocation result, so it can never be mistaken
        // for a cancel that arrived before the provider was called.
        if (cancelRequested && !cancelSent) {
          send({ cmd: "cancel" });
          cancelSent = true;
        }
        response = send({ cmd: "step" });
        emit(response);
        if (response.status === "done") return finish({ ...response, events: [] });
        expectStatus(response, "need_input");
        if (cancelRequested) continue;

        if (exhausted) {
          // The provider has nothing more to give but the executor wants input: tell it the
          // stream is over so it can end the attempt instead of waiting forever.
          if (closed) throw new HostProtocolError("stalled", "the executor kept waiting after the provider finished");
          closed = true;
          send({ cmd: "feed", items: [], observed: "invoked", ended: true });
          continue;
        }
        const batch = await Promise.race([guarded(), aborted]);
        if (batch === "aborted") continue;
        if (batch === null) exhausted = true;
        else feed(batch);
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      // Release the provider stream without waiting on a blocked transport read.
      void iterator?.return?.()?.catch?.(() => undefined);
      session.free();
    }
  }
}
