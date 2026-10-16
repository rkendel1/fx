// @ts-check
// The unified runtime for Node: Chip's work loop (a WebAssembly module built from
// rkendel1/chip-rs) joined to the authoritative FX runtime (`createFxRuntime`) and an
// explicit capability executor.
//
//   agent input (goal, capabilities, policy)
//     -> Chip (wasm): validates the model's decision, authorizes the capability, constructs the execution
//     -> need_inference  -> FX (wasm session) -> Easy-LLM provider -> FX report -> Chip
//     -> need_execution  -> the executor the caller supplied -> result -> Chip (an observation)
//     -> Chip's final work result
//
// This file schedules and translates. It does not parse a model's decision, authorize a
// capability, retry anything, route to another provider, or call a provider: Chip decides,
// FX executes inference, and the executor the caller passed executes capabilities.

import { HostProtocolError, JsonSession, loadExports } from "./wasm.js";

/** The Chip session ABI and protocol versions this host speaks. */
export const CHIP_ABI_VERSION = 1;
export const CHIP_PROTOCOL_VERSION = 1;

/**
 * @typedef {object} CapabilityDeclaration
 * @property {string} id a semantic name such as `vendor.operation`
 * @property {string} name
 * @property {string} [description]
 * @property {Array<{ name: string, description?: string, required?: boolean }>} [inputs]
 *
 * @typedef {object} ExecutionRequest what Chip constructed after validating the model's request
 * @property {string} id assigned by Chip, never by the model
 * @property {string} capability the declared capability to run
 * @property {Record<string, string | number | boolean>} inputs typed inputs, already validated against the declaration
 *
 * @typedef {object} ExecutionOutcome
 * @property {"success" | "failure" | "cancelled"} status
 * @property {string} [output]
 * @property {string} [receipt_id]
 *
 * @typedef {(execution: ExecutionRequest) => Promise<ExecutionOutcome> | ExecutionOutcome} Executor
 *
 * @typedef {object} WorkSpec the agent input
 * @property {string} workId
 * @property {string} goal
 * @property {string} model a provider model id, passed through unchanged
 * @property {CapabilityDeclaration[]} [capabilities] what the model may ask for; empty means nothing
 * @property {{ maxTurns?: number, maxExecutions?: number }} [limits]
 * @property {number} [budgetMs] the per-attempt FX budget
 * @property {"drop_unsupported" | "refuse"} optionsPolicy what to do with sampling options FX cannot carry. No default.
 * @property {string} [requestSeed] 16 lowercase hex digits; random if omitted
 *
 * @typedef {object} WorkOptions
 * @property {import("@easy-llm/llm").LLMProvider | string} provider the explicit provider; nothing here selects one
 * @property {"stream" | "generate"} [mode] passed to FX
 * @property {Executor} [executor] required when capabilities are declared
 * @property {AbortSignal} [signal] cancels the work: FX's attempt is cancelled and Chip makes no further model call
 *
 * @typedef {object} WorkRun
 * @property {Record<string, any>} result Chip's work result: state, summary or reason, measurement, event names
 * @property {Array<{ requestId: string, outcome: string, delivery: string | null, host: Record<string, any> }>} inferences one entry per FX attempt
 * @property {Array<{ id: string, capability: string, status: string }>} executions one entry per capability run
 */

/** Chip's session over the shared ABI. */
export class ChipModule {
  #exports;

  /** @param {Record<string, any>} exports */
  constructor(exports) {
    this.#exports = exports;
  }

  /** @returns {JsonSession} */
  newSession() {
    const handle = this.#exports.chip_session_new(0);
    if (handle === 0) throw new HostProtocolError("session_unavailable", "the module could not create a session");
    return new JsonSession(/** @type {any} */ (this.#exports), handle, "chip", CHIP_PROTOCOL_VERSION);
  }
}

/**
 * Compiles and validates Chip's module: no imports, the shared ABI's exports under `chip_`,
 * matching versions.
 * @param {string | URL | Uint8Array | ArrayBuffer} source
 * @returns {Promise<ChipModule>}
 */
export async function loadChipModule(source) {
  return new ChipModule(await loadExports(source, "chip", { abi: CHIP_ABI_VERSION, protocol: CHIP_PROTOCOL_VERSION }));
}

const encoder = new TextEncoder();

/** @returns {string} 16 lowercase hex digits */
function randomSeed() {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * @param {import("./index.js").FxRuntime} fx the authoritative FX runtime
 * @param {{ chipWasm: string | URL | Uint8Array | ArrayBuffer }} options
 * @returns {Promise<ChipRuntime>}
 */
export async function createChipRuntime(fx, options) {
  if (!fx || typeof fx.execute !== "function") throw new TypeError("createChipRuntime needs the FX runtime from createFxRuntime");
  return new ChipRuntime(await loadChipModule(options.chipWasm), fx);
}

export class ChipRuntime {
  #module;
  #fx;

  /**
   * @param {ChipModule} module
   * @param {import("./index.js").FxRuntime} fx
   */
  constructor(module, fx) {
    this.#module = module;
    this.#fx = fx;
  }

  /**
   * Runs one work to its terminal state. Resolves with Chip's result for every outcome
   * (completed, escalated, blocked, limit reached, failed); rejects only for host
   * programming errors (no provider, no executor, the module misbehaving).
   *
   * @param {WorkSpec} spec the agent input
   * @param {WorkOptions} options the explicit provider, executor and cancellation
   * @returns {Promise<WorkRun>}
   */
  async runWork(spec, options) {
    const { provider, executor, signal } = options ?? {};
    if (provider === undefined || provider === null) throw new TypeError("runWork requires an explicit provider; the runtime never selects one");
    const capabilities = spec.capabilities ?? [];
    if (capabilities.length > 0 && typeof executor !== "function") {
      throw new TypeError("runWork requires an executor when capabilities are declared");
    }
    if (spec.optionsPolicy !== "drop_unsupported" && spec.optionsPolicy !== "refuse") {
      throw new TypeError('spec.optionsPolicy must be "drop_unsupported" or "refuse"');
    }

    const session = this.#module.newSession();
    /** @type {WorkRun["inferences"]} */
    const inferences = [];
    /** @type {WorkRun["executions"]} */
    const executions = [];
    const onAbort = () => {
      // Chip makes no further model call after a cancel. The FX attempt in flight is cancelled
      // by the same signal, inside the FX runtime, with its delivery certainty intact.
      try {
        session.command({ cmd: "cancel" });
      } catch {
        // The session is idle between calls; a failure here surfaces on the next call.
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      let response = session.begin(
        encoder.encode(
          JSON.stringify({
            v: CHIP_PROTOCOL_VERSION,
            work_id: spec.workId,
            goal: spec.goal,
            model: spec.model,
            request_seed: spec.requestSeed ?? randomSeed(),
            options_policy: spec.optionsPolicy,
            capabilities,
            ...(spec.limits && { limits: { max_turns: spec.limits.maxTurns, max_executions: spec.limits.maxExecutions } }),
            ...(spec.budgetMs !== undefined && { budget_ms: spec.budgetMs }),
          }),
        ),
      );
      if (signal?.aborted) onAbort();

      for (;;) {
        switch (response.status) {
          case "done":
            return { result: response.result, inferences, executions };
          case "need_inference": {
            const fxResult = await this.#fx.execute(response.request, {
              provider,
              ...(options.mode && { mode: options.mode }),
              ...(signal && { signal }),
            });
            const outcome = fxResult.report.outcome;
            inferences.push({
              requestId: response.request_id,
              outcome: outcome.type,
              delivery: outcome.delivery ?? fxResult.report.diagnostics?.delivery ?? null,
              host: fxResult.host,
            });
            response = session.command({ cmd: "inference_result", report: { v: 1, report: fxResult.report } });
            break;
          }
          case "need_execution": {
            const execution = /** @type {ExecutionRequest} */ (response.execution);
            /** @type {Record<string, unknown>} */
            let answer;
            try {
              const outcome = await /** @type {Executor} */ (executor)(execution);
              answer = { cmd: "execution_result", status: outcome.status, output: outcome.output ?? "", ...(outcome.receipt_id && { receipt_id: outcome.receipt_id }) };
              executions.push({ id: execution.id, capability: execution.capability, status: outcome.status });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              answer = { cmd: "execution_result", error: "failed", output: message };
              executions.push({ id: execution.id, capability: execution.capability, status: "error" });
            }
            response = session.command(answer);
            break;
          }
          default:
            throw new HostProtocolError(response.error?.code ?? "unexpected_status", `Chip answered ${response.status ?? "nothing"}`);
        }
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      session.free();
    }
  }
}
