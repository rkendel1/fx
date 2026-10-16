// @ts-check
// `npm run conformance`: run the provider conformance suite offline, check the capability
// manifest against the results, and optionally write or check the generated document.
//
//   --json                 print the results as JSON (deterministic: no timings)
//   --repeat N             run the suite N times and fail unless every run gives identical results
//   --provider a,b         only these providers (skips the manifest and document checks)
//   --case x,y             only these cases (skips the manifest and document checks)
//   --write-doc PATH       write the generated provider support document
//   --check-doc PATH       fail if PATH differs from the generated document
//
// Exit status: 0 when every case held and the manifest matches; 1 otherwise. No credentials,
// no network beyond 127.0.0.1.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import * as easyLlm from "@easy-llm/llm";

import { loadManifest, verifyManifest } from "../conformance/manifest.mjs";
import { formatConsole, formatMarkdown, toJson } from "../conformance/report.mjs";
import { runSuite } from "../conformance/suite.mjs";

const args = process.argv.slice(2);
/** @param {string} name */
const flag = (name) => args.includes(name);
/** @param {string} name */
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const subset = value("--provider") !== undefined || value("--case") !== undefined;
const repeat = Math.max(1, Number(value("--repeat") ?? 1));
const providers = value("--provider")?.split(",");
const cases = value("--case")?.split(",");
const wasm = process.env.FX_WASM ? resolve(process.env.FX_WASM) : undefined;

/** @type {import("../conformance/suite.mjs").CaseResult[] | undefined} */
let results;
let problems = 0;
for (let round = 1; round <= repeat; round += 1) {
  const next = await runSuite({ easyLlm, ...(wasm && { wasm }), ...(providers && { providers }), ...(cases && { cases }) });
  if (results && toJson(results) !== toJson(next)) {
    process.stderr.write(`run ${round} differs from run 1: the suite is not deterministic\n`);
    problems += 1;
  }
  results ??= next;
}
const final = /** @type {import("../conformance/suite.mjs").CaseResult[]} */ (results);

if (flag("--json")) process.stdout.write(toJson(final));
else process.stdout.write(`${formatConsole(final)}\n`);

if (final.some((result) => result.status === "fail")) problems += 1;

if (!subset) {
  const manifest = loadManifest();
  const manifestProblems = verifyManifest(manifest, final);
  if (manifestProblems.length > 0) {
    process.stderr.write(`manifest does not match the conformance results:\n${manifestProblems.map((line) => `  ${line}`).join("\n")}\n`);
    problems += 1;
  } else {
    process.stdout.write("manifest matches the conformance results\n");
  }
  const document = formatMarkdown(manifest, final);
  const write = value("--write-doc");
  const checkDoc = value("--check-doc");
  if (write) writeFileSync(write, document);
  if (checkDoc && readFileSync(checkDoc, "utf8") !== document) {
    process.stderr.write(`${checkDoc} is out of date; run: npm run conformance -- --write-doc ${checkDoc}\n`);
    problems += 1;
  }
}
if (repeat > 1 && problems === 0) process.stdout.write(`${repeat} runs gave identical results\n`);
process.exit(problems === 0 ? 0 : 1);
