// @ts-check
// Runs every conformance case against every applicable provider and returns a deterministic
// result list. No timings or timestamps are recorded: the same code gives the same list.

import { checkInvariants, createHarness, PROVIDERS } from "./harness.mjs";
import { CASES, check } from "./cases.mjs";

/**
 * @typedef {"pass" | "limitation" | "fail"} Status
 * @typedef {object} CaseResult
 * @property {string} provider
 * @property {string} case
 * @property {number} group
 * @property {string} title
 * @property {string[]} features
 * @property {Status} status
 * @property {string[]} limitations documented gaps this case recorded
 * @property {string} [error] why it failed
 */

/** A case that does not finish in this long failed: a hang is how a lost cancellation shows up. */
const CASE_TIMEOUT_MS = 20_000;

/**
 * @template T
 * @param {Promise<T>} work @param {string} label
 * @returns {Promise<T>}
 */
function withDeadline(work, label) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not finish within ${CASE_TIMEOUT_MS} ms`)), CASE_TIMEOUT_MS);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/**
 * @param {object} options
 * @param {typeof import("@easy-llm/llm")} options.easyLlm
 * @param {string | URL | Uint8Array} [options.wasm]
 * @param {readonly string[]} [options.providers] default: all
 * @param {readonly string[]} [options.cases] case ids; default: all
 * @returns {Promise<CaseResult[]>}
 */
export async function runSuite({ easyLlm, wasm, providers = PROVIDERS, cases }) {
  const harness = await createHarness({ easyLlm, ...(wasm && { wasm }) });
  /** @type {CaseResult[]} */
  const results = [];
  try {
    for (const provider of providers) {
      for (const testCase of CASES) {
        if (cases && !cases.includes(testCase.id)) continue;
        if (testCase.providers && !testCase.providers.includes(/** @type {any} */ (provider))) continue;
        /** @type {string[]} */
        const limitations = [];
        /** @type {CaseResult} */
        const result = {
          provider,
          case: testCase.id,
          group: testCase.group,
          title: testCase.title,
          features: testCase.features,
          status: "pass",
          limitations,
        };
        try {
          await withDeadline(testCase.run({
            provider: /** @type {any} */ (provider),
            pick: (table) => {
              const value = provider in table ? /** @type {any} */ (table)[provider] : table.default;
              if (value === undefined && !(provider in table)) throw new Error(`no expectation for ${provider}`);
              return value;
            },
            run: async (scenario, mode, options) => {
              const run = await harness.run(/** @type {any} */ (provider), scenario, mode, options);
              checkInvariants(run, `${provider}/${scenario}/${mode}`);
              return run;
            },
            check,
            limitation: (note, assertions) => {
              assertions();
              limitations.push(note);
            },
          }), `${provider}/${testCase.id}`);
          if (limitations.length > 0) result.status = "limitation";
        } catch (error) {
          result.status = "fail";
          result.error = error instanceof Error ? error.message : String(error);
        }
        results.push(result);
      }
    }
  } finally {
    await harness.close();
  }
  return results;
}
