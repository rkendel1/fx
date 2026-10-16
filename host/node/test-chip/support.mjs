// Shared setup for the Chip end-to-end tests. Needs CHIP_WASM; with it missing the suites FAIL
// (a skipped lane is not a passing lane).

import assert from "node:assert/strict";

import * as easyLlm from "@easy-llm/llm";

import { startSequenceServer } from "../examples/mock-sequence.mjs";
import { createChipRuntime, createFxRuntime } from "../src/index.js";

export { easyLlm };
export const KEY = "sk-MOCKKEYMOCKKEYMOCKKEY0123456789";
export const REQUEST_SELFTEST = '{"decision":"request_capability","capability":"compute.selftest","inputs":{"n":3}}';
export const COMPLETE = '{"decision":"complete","summary":"the self test passed"}';

export const spec = (over = {}) => ({
  workId: "w",
  goal: "Run the self test with n=3 and report the result",
  model: "example-model",
  optionsPolicy: "drop_unsupported",
  capabilities: [{ id: "compute.selftest", name: "selftest", description: "runs the self test", inputs: [{ name: "n", required: true }] }],
  ...over,
});

/** The runtimes, built once per suite from the two WebAssembly modules. */
export async function runtimes() {
  const chipWasm = process.env.CHIP_WASM;
  assert.ok(chipWasm, "CHIP_WASM must name Chip's module (build rkendel1/chip-rs: cargo build -p chip-wasm-host --target wasm32-unknown-unknown --release)");
  const fx = await createFxRuntime({ easyLlm });
  const chip = await createChipRuntime(fx, { chipWasm });
  return { fx, chip };
}

/** Runs a work against a scripted endpoint and returns what happened. */
export async function scenario(chip, replies, { specOver, mode = "stream", executor, signal, afterRun } = {}) {
  const server = await startSequenceServer(replies);
  const executed = [];
  const provider = easyLlm.createOpenAIAdapter(KEY, server.url);
  try {
    const run = await chip.runWork(specOver ?? spec(), {
      provider,
      mode,
      signal,
      executor:
        executor ??
        ((execution) => {
          executed.push(execution);
          return { status: "success", output: `self test ${execution.inputs.n} passed`, receipt_id: "sha256:r" };
        }),
    });
    if (afterRun) await afterRun(server);
    return { run, server, executed };
  } finally {
    await server.close();
  }
}
