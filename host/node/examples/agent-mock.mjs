// @ts-check
// A multi-step agent work, offline, through the whole path:
//
//   goal -> Chip (wasm) -> FX (wasm) -> the real Easy-LLM OpenAI adapter -> a local mock endpoint
//        <- Chip validates the model's decision, authorizes one declared capability, constructs the execution
//        -> the executor below runs it (an explicit, test-only capability)
//        -> its result is an observation in the next inference -> Chip completes the work
//
// Needs the two WebAssembly modules: FX's (`npm run build:wasm`) and Chip's, built from
// rkendel1/chip-rs (`CHIP_WASM=/path/to/chip_wasm_host.wasm`). No credentials, no network.

import * as easyLlm from "@easy-llm/llm";

import { createChipRuntime, createFxRuntime } from "../src/index.js";
import { startSequenceServer } from "./mock-sequence.mjs";

const chipWasm = process.env.CHIP_WASM;
if (!chipWasm) {
  process.stderr.write("set CHIP_WASM to Chip's module (cargo build -p chip-wasm-host --target wasm32-unknown-unknown --release in rkendel1/chip-rs)\n");
  process.exit(2);
}

const server = await startSequenceServer([
  { text: '{"decision":"request_capability","capability":"compute.selftest","inputs":{"n":3}}' },
  { text: '{"decision":"complete","summary":"the self test passed"}' },
]);
try {
  const fx = await createFxRuntime({ easyLlm });
  const chip = await createChipRuntime(fx, { chipWasm });
  const provider = easyLlm.createOpenAIAdapter("sk-EXAMPLEKEYEXAMPLEKEY0123456789", server.url);

  const run = await chip.runWork(
    {
      workId: "example",
      goal: "Run the self test with n=3 and report the result",
      model: "example-model",
      optionsPolicy: "drop_unsupported",
      capabilities: [
        { id: "compute.selftest", name: "selftest", description: "runs the self test", inputs: [{ name: "n", required: true }] },
      ],
    },
    {
      provider,
      mode: "stream",
      // The only place anything is executed. Chip authorized this call; FX never sees it.
      executor: (execution) => ({ status: "success", output: `self test ${execution.inputs.n} passed`, receipt_id: "sha256:example" }),
    },
  );

  process.stdout.write(`${JSON.stringify({ result: run.result, inferences: run.inferences.length, executions: run.executions }, null, 2)}\n`);
  process.exitCode = run.result.state === "completed" ? 0 : 1;
} finally {
  await server.close();
}
