// The unified runtime, end to end and offline: Chip (wasm built from rkendel1/chip-rs) ->
// the authoritative FX (wasm) -> the real Easy-LLM OpenAI adapter -> a local mock endpoint.
// Needs CHIP_WASM; with it missing the suite FAILS (a skipped lane is not a passing lane).

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import * as easyLlm from "@easy-llm/llm";

import { startSequenceServer } from "../examples/mock-sequence.mjs";
import { createChipRuntime, createFxRuntime, HostProtocolError, loadChipModule } from "../src/index.js";
import { defaultWasmPath } from "../src/index.js";

const KEY = "sk-MOCKKEYMOCKKEYMOCKKEY0123456789";
const CHIP_WASM = process.env.CHIP_WASM;
const REQUEST_SELFTEST = '{"decision":"request_capability","capability":"compute.selftest","inputs":{"n":3}}';
const COMPLETE = '{"decision":"complete","summary":"the self test passed"}';

const spec = (over = {}) => ({
  workId: "w",
  goal: "Run the self test with n=3 and report the result",
  model: "example-model",
  optionsPolicy: "drop_unsupported",
  capabilities: [{ id: "compute.selftest", name: "selftest", description: "runs the self test", inputs: [{ name: "n", required: true }] }],
  ...over,
});

let fx;
let chip;
before(async () => {
  assert.ok(CHIP_WASM, "CHIP_WASM must name Chip's module (build rkendel1/chip-rs: cargo build -p chip-wasm-host --target wasm32-unknown-unknown --release)");
  fx = await createFxRuntime({ easyLlm });
  chip = await createChipRuntime(fx, { chipWasm: CHIP_WASM });
});

/** Runs a work against a scripted endpoint. */
async function scenario(replies, { specOver, mode = "stream", executor, signal, afterRun } = {}) {
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

describe("a multi-step work through Chip, FX and Easy-LLM", () => {
  for (const mode of ["stream", "generate"]) {
    test(`runs the authorized capability and feeds its result to the next inference (${mode})`, async () => {
      const { run, server, executed } = await scenario([{ text: REQUEST_SELFTEST }, { text: COMPLETE }], { mode });
      assert.equal(run.result.state, "completed");
      assert.equal(run.result.summary, "the self test passed");
      assert.equal(run.result.measurement.model_calls, 2);
      assert.deepEqual(run.result.trajectory_problems, []);
      assert.equal(server.requests.length, 2, "one provider request per FX attempt");
      assert.equal(run.inferences.length, 2);
      assert.ok(run.inferences.every((i) => i.outcome === "completed" && i.host.providerInvocations === 1));
      assert.equal(executed.length, 1, "Chip ran the capability once");
      assert.equal(executed[0].capability, "compute.selftest");
      assert.deepEqual(executed[0].inputs, { n: 3 });
      assert.match(executed[0].id, /^w-exec-/, "the execution id is Chip's");
      assert.match(JSON.stringify(server.requests[1].body.messages), /self test 3 passed/, "the result reached the next inference");
      for (const request of server.requests) {
        assert.equal(request.body.tools, undefined, "no provider tools are ever sent");
      }
    });
  }

  test("the credential reaches the provider and appears nowhere in the result", async () => {
    const { run } = await scenario([{ text: COMPLETE }]);
    assert.ok(!JSON.stringify(run).includes(KEY));
  });
});

describe("Chip owns authorization and orchestration", () => {
  test("a capability the host did not declare is rejected and nothing executes", async () => {
    for (const reply of [
      '{"decision":"request_capability","capability":"deploy.production"}',
      '{"decision":"request_capability","capability":"compute.selftest","shell":"rm -rf /"}',
      '{"decision":"request_capability","capability":"compute.selftest","inputs":{"command":"rm -rf /"}}',
    ]) {
      const { run, server, executed } = await scenario([{ text: reply }, { text: COMPLETE }]);
      assert.notEqual(run.result.state, "completed", reply);
      assert.equal(executed.length, 0, `${reply}: the proposal ran nothing`);
      assert.equal(server.requests.length, 1, `${reply}: no repair inference`);
    }
  });

  test("a malformed decision fails the work without a retry", async () => {
    for (const reply of ["I will now run the self test.", "", "{not json"]) {
      const { run, server, executed } = await scenario([{ text: reply }, { text: COMPLETE }]);
      assert.equal(run.result.state, "failed");
      assert.match(run.result.reason, /not a valid decision/);
      assert.equal(executed.length, 0);
      assert.equal(server.requests.length, 1);
    }
  });

  test("a capability that fails is an observation, not a reason to repeat inference", async () => {
    const { run, server } = await scenario(
      [{ text: REQUEST_SELFTEST }, { text: '{"decision":"block","reason":"the self test failed"}' }],
      { executor: () => ({ status: "failure", output: "boom" }) },
    );
    assert.equal(run.result.state, "blocked");
    assert.equal(server.requests.length, 2);
    assert.match(JSON.stringify(server.requests[1].body.messages), /boom/);
  });

  test("an executor that throws is reported to Chip as a failed execution, which ends the work", async () => {
    const { run, server } = await scenario([{ text: REQUEST_SELFTEST }, { text: COMPLETE }], {
      executor: () => {
        throw new Error("executor down");
      },
    });
    assert.equal(run.executions[0].status, "error");
    // Chip's rule: an execution that errors (as opposed to one that reports failure) is terminal.
    assert.equal(run.result.state, "failed");
    assert.equal(server.requests.length, 1, "no further inference after the execution error");
  });
});

describe("failure, delivery and cancellation", () => {
  test("a provider failure ends the work with its delivery and is not retried", async () => {
    const { run, server } = await scenario([{ status: 429, headers: { "Retry-After": "3" } }, { text: COMPLETE }]);
    assert.equal(run.result.state, "failed");
    assert.match(run.result.reason, /rate_limited/);
    assert.match(run.result.reason, /possibly_sent/);
    assert.match(run.result.reason, /not retried/);
    assert.equal(server.requests.length, 1, "the ambiguous attempt was not repeated");
    assert.equal(run.inferences.length, 1);
  });

  test("a stream with no verified finish is not a success", async () => {
    const { run, server } = await scenario([{ text: COMPLETE, finish: null }, { text: COMPLETE }]);
    assert.equal(run.result.state, "failed", "even though the cut stream held a valid decision");
    assert.equal(server.requests.length, 1);
    assert.equal(run.inferences[0].outcome, "failed");
  });

  test("a request FX refuses never reaches the provider", async () => {
    const { run, server } = await scenario([{ text: COMPLETE }], { specOver: spec({ optionsPolicy: "refuse" }) });
    assert.equal(run.result.state, "failed");
    assert.equal(server.requests.length, 0);
  });

  test("cancelling before the provider is invoked sends nothing", async () => {
    const controller = new AbortController();
    controller.abort();
    const { run, server } = await scenario([{ text: COMPLETE }], { signal: controller.signal });
    assert.equal(run.result.state, "failed");
    assert.match(run.result.reason, /cancelled/);
    assert.match(run.result.reason, /definitely_unsent/);
    assert.equal(server.requests.length, 0);
  });

  test("cancelling after invocation is never reported as unsent, and the connection is closed", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 80);
    const { run, server } = await scenario([{ hang: true }, { text: COMPLETE }], {
      signal: controller.signal,
      afterRun: async (s) => {
        const until = Date.now() + 1000;
        while (s.closedByClient() === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
      },
    });
    assert.equal(run.result.state, "failed");
    assert.match(run.result.reason, /cancelled/);
    assert.doesNotMatch(run.result.reason, /definitely_unsent/);
    assert.equal(server.requests.length, 1, "no second call after a cancel");
    assert.equal(server.closedByClient(), 1);
  });
});

describe("the host boundary", () => {
  test("the runtime requires an explicit provider, executor and options policy", async () => {
    await assert.rejects(chip.runWork(spec(), {}), TypeError);
    await assert.rejects(chip.runWork(spec(), { provider: easyLlm.createOpenAIAdapter(KEY, "http://127.0.0.1:9/v1") }), TypeError);
    await assert.rejects(
      chip.runWork(spec({ optionsPolicy: undefined }), { provider: easyLlm.createOpenAIAdapter(KEY, "http://127.0.0.1:9/v1"), executor: () => ({ status: "success" }) }),
      TypeError,
    );
  });

  test("Chip's module imports nothing, and a module that is not Chip's is refused", async () => {
    await assert.rejects(loadChipModule(defaultWasmPath()), (error) => error instanceof HostProtocolError && error.code === "missing_exports");
    await assert.rejects(
      loadChipModule(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 2, 7, 1, 1, 120, 1, 121, 0, 0])),
      (error) => error instanceof HostProtocolError && error.code === "unexpected_imports",
    );
  });

  test("sessions are independent", async () => {
    const [a, b] = await Promise.all([
      scenario([{ text: '{"decision":"complete","summary":"a"}' }]),
      scenario([{ text: '{"decision":"complete","summary":"b"}' }]),
    ]);
    assert.equal(a.run.result.summary, "a");
    assert.equal(b.run.result.summary, "b");
  });
});
