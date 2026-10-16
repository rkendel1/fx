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
// Providers: the OpenAI-compatible wire format (covers OpenRouter and LM Studio, which speak it)
// and Anthropic. Easy-LLM's streamed Anthropic path does not carry the stop reason or usage (a
// recorded limitation), so for Anthropic those fields are not compared with the Node path; the
// native values are instead checked against the bytes the mock sent (NATIVE_ONLY below).
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
  "openai:garbage": {
    why: "Easy-LLM skips unparseable stream lines and completes; the native adapter treats them as a protocol violation and keeps the text so far.",
    native: { type: "failed", kind: "protocol_violation", origin: "capability", delivery: "confirmed_response", status_hint: null, retry_after_ms: null, partial: "a " },
  },
  "openai:tool-call": {
    why: "No tools were offered. Easy-LLM surfaces the call as a proposal that FX then refuses; the native adapter fails the attempt as a protocol violation before any proposal exists.",
    native: { type: "failed", kind: "protocol_violation", origin: "capability", delivery: "confirmed_response", status_hint: null, retry_after_ms: null, partial: "a" },
  },
  "anthropic:claims-tools": {
    why: "The stream stops for a tool call although none was offered. Easy-LLM completes with finish reason other; the native adapter fails the attempt as a protocol violation.",
    native: { type: "failed", kind: "protocol_violation", origin: "capability", delivery: "confirmed_response", status_hint: null, retry_after_ms: null, partial: "x" },
  },
  "anthropic:empty-body": {
    why: "A 200 response with no bytes. Easy-LLM reports the delivery as possibly sent; the native adapter, which saw a complete 2xx response, reports a confirmed response.",
    native: { type: "failed", kind: "transport", origin: "executor", delivery: "confirmed_response", status_hint: null, retry_after_ms: null, partial: null },
  },
  "anthropic:garbage": {
    why: "Easy-LLM skips unparseable stream lines and completes; the native adapter treats them as a protocol violation and keeps the text so far.",
    native: { type: "failed", kind: "protocol_violation", origin: "capability", delivery: "confirmed_response", status_hint: null, retry_after_ms: null, partial: "a " },
  },
  "openai:late": {
    why: "Easy-LLM's OpenAI adapter keeps reading after [DONE] (a recorded limitation, late-chunks-after-terminal); the native adapter stops at the provider's marker and never reads or forwards what follows.",
    native: { type: "completed", finish_reason: "stop", content: "a ", input_tokens: null, output_tokens: null, proposals: 0 },
  },
};

/**
 * What the native Anthropic provider reports in the fields Easy-LLM drops, per the bytes the
 * mock sends (scenarios.mjs). Checked against the native outcome.
 * @type {Record<string, { finish_reason: string, input_tokens: number | null, output_tokens: number | null }>}
 */
const NATIVE_ONLY = {
  "anthropic:ok": { finish_reason: "stop", input_tokens: 5, output_tokens: 2 },
  "anthropic:length": { finish_reason: "length", input_tokens: null, output_tokens: null },
  "anthropic:filter": { finish_reason: "content_filter", input_tokens: null, output_tokens: null },
  "anthropic:unknown": { finish_reason: "other", input_tokens: null, output_tokens: null },
  "anthropic:empty-terminal": { finish_reason: "stop", input_tokens: null, output_tokens: null },
  "anthropic:late": { finish_reason: "stop", input_tokens: null, output_tokens: null },
  "anthropic:usage-none": { finish_reason: "stop", input_tokens: null, output_tokens: null },
  "anthropic:usage-partial": { finish_reason: "stop", input_tokens: 5, output_tokens: 2 },
  "anthropic:usage-invalid": { finish_reason: "stop", input_tokens: 5, output_tokens: 2 },
  "anthropic:tool-call": { finish_reason: "stop", input_tokens: null, output_tokens: null },
};

/** Scenarios whose partial text keeps growing until the deadline: only its start is stable. */
const TIMING_DEPENDENT = new Set(["drip"]);

/** @param {Record<string, any>} o @param {string} scenario */
function partial(o, scenario) {
  const text = o.partial?.content ?? null;
  return text !== null && TIMING_DEPENDENT.has(scenario) ? text.slice(0, 6) : text;
}

/** @param {Record<string, any>} o @param {string} scenario @param {string} provider */
function project(o, scenario, provider) {
  switch (o.type) {
    case "completed":
      return {
        type: o.type,
        // Easy-LLM does not carry these on a streamed Anthropic response.
        ...(provider === "anthropic" ? {} : { finish_reason: o.finish_reason }),
        content: o.content,
        ...(provider === "anthropic"
          ? {}
          : { input_tokens: o.usage?.input_tokens ?? null, output_tokens: o.usage?.output_tokens ?? null }),
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

const PROVIDERS = ["openai", "anthropic"];

const harness = await createHarness({ easyLlm });
const rows = [];
let problems = 0;
try {
  for (const provider of PROVIDERS) for (const [scenario, budget] of SCENARIOS) {
    const base = harness.mocks.base(/** @type {any} */ (provider));
    const node = project((await harness.run(/** @type {any} */ (provider), scenario, "stream", budget ? { budget } : {})).outcome, scenario, provider);
    const child = await runNative([provider, base, scenario, ...(budget ? [String(budget)] : [])]);
    if (child.status !== 0) {
      process.stderr.write(`${provider}:${scenario}: native run failed (${child.status}): ${child.stderr}\n`);
      problems += 1;
      continue;
    }
    if (child.stdout.includes(API_KEY)) {
      process.stderr.write(`${provider}:${scenario}: the credential appears in the native outcome\n`);
      problems += 1;
    }
    const rawNative = JSON.parse(child.stdout).outcome;
    const native = project(rawNative, scenario, provider);
    const wanted = NATIVE_ONLY[`${provider}:${scenario}`];
    if (wanted !== undefined) {
      const got = { finish_reason: rawNative.finish_reason, input_tokens: rawNative.usage?.input_tokens ?? null, output_tokens: rawNative.usage?.output_tokens ?? null };
      if (JSON.stringify(got) !== JSON.stringify(wanted)) {
        problems += 1;
        process.stderr.write(`${provider}:${scenario}: native-only fields ${JSON.stringify(got)}, expected ${JSON.stringify(wanted)}\n`);
      }
    }
    const same = JSON.stringify(node) === JSON.stringify(native);
    const known = DIVERGENCES[`${provider}:${scenario}`];
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
      process.stderr.write(`${provider}:${scenario}: ${verdict}\n  node:   ${JSON.stringify(node)}\n  native: ${JSON.stringify(native)}\n`);
    }
    rows.push({ scenario: `${provider}:${scenario}`, verdict });
  }
} finally {
  await harness.close();
}

for (const { scenario, verdict } of rows) process.stdout.write(`${verdict.padEnd(24)} ${scenario}\n`);
const matches = rows.filter((r) => r.verdict === "match").length;
process.stdout.write(`\n${matches} identical, ${rows.length - matches} other, ${problems} problem(s)\n`);
process.exit(problems === 0 ? 0 : 1);
