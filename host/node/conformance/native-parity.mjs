// @ts-check
// Native-versus-Node parity for the OpenAI-compatible wire format.
//
// The same mock server (mock-providers.mjs, the scenarios the Node conformance suite uses)
// is driven twice per scenario:
//
//   1. through the Node-backed path: Rust executor (WebAssembly) -> Easy-LLM streamOnce
//   2. through the native path:      Rust executor (native)       -> fx-native-provider
//
// Both print the terminal outcome in FX's own wire encoding. The comparison keeps the contract
// fields (outcome type, finish reason, text, usage counts, error kind, failure origin, delivery
// certainty, status, retry-after, partial text) and ignores provider message text.
//
// Scenarios in DIVERGENCES are known, documented differences: the script fails if one of them
// starts to match (stale entry) or differs in a way other than recorded. Every other scenario
// must be identical. This is mocked-transport evidence for both paths; it says nothing about a
// live provider.
//
//   node conformance/native-parity.mjs [--bin PATH]   (default: the debug example build)

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import * as easyLlm from "@easy-llm/llm";

import { API_KEY, createHarness } from "./harness.mjs";

const args = process.argv.slice(2);
const binIndex = args.indexOf("--bin");
const bin = resolve(
  binIndex >= 0 ? args[binIndex + 1] : new URL("../../../rust/fx-native-provider/target/debug/examples/native_parity", import.meta.url).pathname,
);
if (!existsSync(bin)) {
  process.stderr.write(`native parity binary not found: ${bin}\nbuild it: cargo build --manifest-path rust/fx-native-provider/Cargo.toml --example native_parity\n`);
  process.exit(2);
}

/** Scenarios and the attempt budget (ms) each needs. */
const SCENARIOS = /** @type {[string, number?][]} */ ([
  ["ok"], ["length"], ["filter"], ["unknown"], ["claims-tools"], ["empty-body"], ["empty-terminal"],
  ["no-finish"], ["garbage"], ["late"], ["usage-none"], ["usage-partial"], ["usage-invalid"], ["tool-call"],
  ["http-401"], ["http-403"], ["http-404"], ["http-429"], ["http-429-bad-retry"], ["http-429-no-retry"],
  ["http-500"], ["http-502-html"], ["reset-before-response"], ["reset-mid-stream"], ["hang", 400], ["drip", 400],
]);

/**
 * Known differences. `native` is the native projection the script requires, so a different
 * difference also fails.
 * @type {Record<string, { why: string, native: Record<string, unknown> }>}
 */
const DIVERGENCES = {
  garbage: {
    why: "Easy-LLM skips unparseable stream lines and completes; the native adapter treats them as a protocol violation and keeps the text so far.",
    native: { type: "failed", kind: "protocol_violation", origin: "capability", delivery: "confirmed_response", status_hint: null, retry_after_ms: null, partial: "a " },
  },
  "tool-call": {
    why: "No tools were offered. Easy-LLM surfaces the call as a proposal that FX then refuses; the native adapter fails the attempt as a protocol violation before any proposal exists.",
    native: { type: "failed", kind: "protocol_violation", origin: "capability", delivery: "confirmed_response", status_hint: null, retry_after_ms: null, partial: "a" },
  },
  late: {
    why: "Easy-LLM's OpenAI adapter keeps reading after [DONE] (a recorded limitation, late-chunks-after-terminal); the native adapter stops at the provider's marker and never reads or forwards what follows.",
    native: { type: "completed", finish_reason: "stop", content: "a ", input_tokens: null, output_tokens: null, proposals: 0 },
  },
};

/** Scenarios whose partial text keeps growing until the deadline: only its start is stable. */
const TIMING_DEPENDENT = new Set(["drip"]);

/** @param {Record<string, any>} o @param {string} scenario */
function partial(o, scenario) {
  const text = o.partial?.content ?? null;
  return text !== null && TIMING_DEPENDENT.has(scenario) ? text.slice(0, 6) : text;
}

/** @param {Record<string, any>} o @param {string} scenario */
function project(o, scenario) {
  switch (o.type) {
    case "completed":
      return {
        type: o.type,
        finish_reason: o.finish_reason,
        content: o.content,
        input_tokens: o.usage?.input_tokens ?? null,
        output_tokens: o.usage?.output_tokens ?? null,
        proposals: o.proposals.length,
      };
    case "failed":
      return {
        type: o.type,
        kind: o.kind,
        origin: o.origin,
        delivery: o.delivery,
        status_hint: o.status_hint,
        retry_after_ms: o.retry_after_ms,
        partial: partial(o, scenario),
      };
    default:
      return { type: o.type, delivery: o.delivery, remote: o.remote, partial: partial(o, scenario) };
  }
}

/**
 * Asynchronous on purpose: the mock server lives in this process, so a blocking spawn would
 * stop it from answering.
 * @param {string[]} argv
 * @returns {Promise<{ status: number | null, stdout: string, stderr: string }>}
 */
function runNative(argv) {
  return new Promise((done) => {
    const child = spawn(bin, argv, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (piece) => (stdout += piece));
    child.stderr.on("data", (piece) => (stderr += piece));
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      done({ status, stdout, stderr });
    });
  });
}

const harness = await createHarness({ easyLlm });
const rows = [];
let problems = 0;
try {
  const base = harness.mocks.base("openai");
  for (const [scenario, budget] of SCENARIOS) {
    const node = project((await harness.run("openai", scenario, "stream", budget ? { budget } : {})).outcome, scenario);
    const child = await runNative([base, scenario, ...(budget ? [String(budget)] : [])]);
    if (child.status !== 0) {
      process.stderr.write(`${scenario}: native run failed (${child.status}): ${child.stderr}\n`);
      problems += 1;
      continue;
    }
    if (child.stdout.includes(API_KEY)) {
      process.stderr.write(`${scenario}: the credential appears in the native outcome\n`);
      problems += 1;
    }
    const native = project(JSON.parse(child.stdout).outcome, scenario);
    const same = JSON.stringify(node) === JSON.stringify(native);
    const known = DIVERGENCES[scenario];
    let verdict;
    if (known === undefined) {
      verdict = same ? "match" : "MISMATCH";
    } else if (same) {
      verdict = "STALE-DIVERGENCE";
    } else {
      verdict = JSON.stringify(native) === JSON.stringify(known.native) ? "documented-difference" : "UNDOCUMENTED-DIFFERENCE";
    }
    if (!["match", "documented-difference"].includes(verdict)) {
      problems += 1;
      process.stderr.write(`${scenario}: ${verdict}\n  node:   ${JSON.stringify(node)}\n  native: ${JSON.stringify(native)}\n`);
    }
    rows.push({ scenario, verdict });
  }
} finally {
  await harness.close();
}

for (const { scenario, verdict } of rows) process.stdout.write(`${verdict.padEnd(24)} ${scenario}\n`);
const matches = rows.filter((r) => r.verdict === "match").length;
process.stdout.write(`\n${matches} identical, ${rows.length - matches} other, ${problems} problem(s)\n`);
process.exit(problems === 0 ? 0 : 1);
