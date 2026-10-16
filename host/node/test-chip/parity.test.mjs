// Behavioral parity between Chip-over-FX and the Zig oracle.
//
// The oracle side is a recording of the real `./zig-out/bin/fx ask --json` binary in scripted
// scenarios (docs/rebuild/evidence/zig-oracle.json, produced by
// docs/rebuild/tools/capture_zig_oracle.py). The Chip side runs for real here: Chip (wasm),
// FX (wasm), the real Easy-LLM adapter, a scripted endpoint. Compared are semantic outcomes
// (how many inference requests, whether a capability ran, whether the work succeeded), not
// internals. Where the two intentionally differ, the difference has an id, an explanation in
// docs/rebuild/CHIP_FX_RUNTIME.md, and a test that pins BOTH sides, so neither can drift.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, describe, test } from "node:test";

import { COMPLETE, REQUEST_SELFTEST, runtimes, scenario as runScenario, spec } from "./support.mjs";

const oracle = JSON.parse(readFileSync(new URL("../../../docs/rebuild/evidence/zig-oracle.json", import.meta.url), "utf8"));
const document = readFileSync(new URL("../../../docs/rebuild/CHIP_FX_RUNTIME.md", import.meta.url), "utf8");

let chip;
before(async () => {
  ({ chip } = await runtimes());
});
const run = (replies, options) => runScenario(chip, replies, options);

const zig = (name) => {
  const entry = oracle.scenarios[name];
  assert.ok(entry, `the oracle recording has no scenario ${name}`);
  return { requests: entry.inference_requests, succeeded: entry.exit_code === 0, tools: entry.output?.tool_calls ?? [], entry };
};

describe("equivalent: the same semantic outcome", () => {
  test("a single text answer is one inference and a completed work", async () => {
    const z = zig("single_text");
    const { run: c, server } = await run([{ text: COMPLETE }]);
    assert.equal(server.requests.length, z.requests);
    assert.equal(c.result.state === "completed", z.succeeded);
  });

  test("a tool round trip is two inferences with the capability run once and its result fed back", async () => {
    const z = zig("tool_round_trip");
    const { run: c, server, executed } = await run([{ text: REQUEST_SELFTEST }, { text: COMPLETE }]);
    assert.equal(server.requests.length, z.requests);
    assert.equal(executed.length, z.tools.length);
    assert.equal(c.result.state === "completed", z.succeeded);
    assert.ok(z.entry.requests[1].tool_results_in_prompt.length === 1, "the oracle fed the result back");
    assert.match(JSON.stringify(server.requests[1].body.messages), /self test 3 passed/, "and so did Chip");
  });

  test("a client error is not retried and ends the work as a failure", async () => {
    const z = zig("http_400");
    const { run: c, server } = await run([{ status: 400 }, { text: COMPLETE }]);
    assert.equal(server.requests.length, z.requests);
    assert.equal(c.result.state === "failed", !z.succeeded);
  });

  test("the step limit bounds inference: the same number of requests, then a non-success end", async () => {
    const z = zig("step_limit");
    const { run: c, server } = await run(Array.from({ length: 5 }, () => ({ text: REQUEST_SELFTEST })), {
      specOver: spec({ limits: { maxTurns: 2 } }),
    });
    assert.equal(server.requests.length, z.requests, "both stop after two inferences");
    assert.equal(c.result.state, "limit_reached");
    assert.equal(z.succeeded, false);
    assert.equal(z.tools.length, 2, "the oracle ran its tool once per step; Chip's executions follow its own limit");
  });
});

describe("intentional differences, each pinned on both sides", () => {
  const mentioned = (id) => assert.match(document, new RegExp(`\\b${id}\\b`), `${id} must be explained in CHIP_FX_RUNTIME.md`);

  for (const name of ["http_429_then_success", "http_500_then_success", "cut_stream_then_success"]) {
    test(`D1 (${name}): the oracle repeats the provider request after an ambiguous outcome; Chip never does`, async () => {
      mentioned("D1");
      const z = zig(name);
      assert.equal(z.requests, 2, "the oracle made a second provider request");
      assert.equal(z.succeeded, true, "and recovered");
      const replies =
        name === "cut_stream_then_success"
          ? [{ text: COMPLETE, finish: null }, { text: COMPLETE }]
          : [{ status: name.includes("429") ? 429 : 500 }, { text: COMPLETE }];
      const { run: c, server } = await run(replies);
      assert.equal(server.requests.length, 1, "Chip made exactly one provider request");
      assert.equal(c.result.state, "failed", "and ended the work with the evidence instead");
      assert.match(c.result.reason, /not retried/);
      assert.doesNotMatch(c.result.reason, /definitely_unsent/);
    });
  }

  test("D2: the oracle sends sampling options and a system prompt; the FX path carries none of that", async () => {
    mentioned("D2");
    const { server } = await run([{ text: COMPLETE }]);
    // Nothing the caller chooses reaches the wire. The temperature that does appear is the
    // Easy-LLM OpenAI adapter's own fixed default (0.7), not an option Chip or FX sent; pinning it
    // means a change in either place is noticed.
    assert.equal(server.requests[0].body.temperature, 0.7, "only the adapter's fixed default");
    assert.equal(server.requests[0].body.max_tokens, undefined, "no max_tokens on the wire");
  });

  for (const [name, reply] of [
    ["unknown_tool", '{"decision":"request_capability","capability":"no.such_thing"}'],
    ["malformed_tool_arguments", "{not json"],
  ]) {
    test(`D3 (${name}): the oracle reports a bad proposal to the model and continues; Chip fails closed without repair`, async () => {
      mentioned("D3");
      const z = zig(name);
      assert.equal(z.requests, 2, "the oracle asked the model again");
      assert.equal(z.succeeded, true);
      assert.ok(z.entry.requests[1].tool_results_in_prompt.length === 1, "after feeding the rejection back");
      const { run: c, server, executed } = await run([{ text: reply }, { text: COMPLETE }]);
      assert.equal(server.requests.length, 1, "Chip did not ask again");
      assert.notEqual(c.result.state, "completed");
      assert.equal(executed.length, 0);
    });
  }

  test("D4: the oracle offers provider-native tool definitions; Chip's actions are text decisions and FX refuses tools", async () => {
    mentioned("D4");
    for (const entry of Object.values(oracle.scenarios)) {
      assert.ok(entry.requests.every((r) => r.tool_definitions > 0), "the oracle always sends tool definitions");
    }
    const { server } = await run([{ text: COMPLETE }]);
    assert.equal(server.requests[0].body.tools, undefined);
  });
});
