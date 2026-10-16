// @ts-check
// The provider capability manifest and its check against conformance results.
//
// The manifest is descriptive evidence, not a runtime contract. A status is only believable if
// the conformance results back it, so `verifyManifest` refuses a manifest that claims more (or
// less) than the cases show.
//
//   supported    at least one case provides evidence for the feature, and every such case passed
//   unsupported  a case recorded the gap as a documented limitation, and none failed
//   unverified   the evidence is missing, mock-only in a way that matters, or ambiguous (a note says why)

import { readFileSync } from "node:fs";

import { PROVIDERS } from "./harness.mjs";

export const STATUSES = Object.freeze(["supported", "unsupported", "unverified"]);

/** Every feature a provider entry must state. The first eleven are the spec's list (tool support is two entries). */
export const FEATURES = Object.freeze([
  "text_generate",
  "text_stream",
  "finish_reason_generate",
  "finish_reason_stream",
  "usage_generate",
  "usage_stream",
  "http_status",
  "retry_after",
  "cancellation",
  "late_events_ignored",
  "malformed_chunks_reported",
  "tool_definitions",
  "tool_call_history",
  "images",
  "generation_options",
  "structured_output",
]);

/** One line per feature, for generated documents. */
export const FEATURE_TEXT = Object.freeze(
  /** @type {Record<string, string>} */ ({
    text_generate: "Non-streaming text generation",
    text_stream: "Streaming text that can complete on provider evidence",
    finish_reason_generate: "Finish reason on a collected response (verified before completing)",
    finish_reason_stream: "Finish reason carried on a stream",
    usage_generate: "Usage metadata on a collected response",
    usage_stream: "Usage metadata on a stream",
    http_status: "HTTP status propagation",
    retry_after: "Retry-After propagation",
    cancellation: "Cancellation reaches the provider connection",
    late_events_ignored: "Output after the provider's terminal marker is ignored",
    malformed_chunks_reported: "A malformed stream chunk fails the attempt instead of being skipped",
    tool_definitions: "Tool definitions",
    tool_call_history: "Tool-call history",
    images: "Images",
    generation_options: "Generation options",
    structured_output: "Structured output",
  }),
);

/**
 * @typedef {import("./suite.mjs").CaseResult} CaseResult
 * @typedef {{ status: string, note?: string }} FeatureEntry
 * @typedef {{ adapter: string, live: string, features: Record<string, FeatureEntry> }} ProviderEntry
 * @typedef {{ schema: number, manifest_version: string, easy_llm: { package: string, version: string }, evidence: { kind: string, note: string }, providers: Record<string, ProviderEntry> }} Manifest
 */

/** @param {string | URL} [path] @returns {Manifest} */
export function loadManifest(path = new URL("./manifest.json", import.meta.url)) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * The cases (for one provider) that provide evidence for a feature.
 * @param {CaseResult[]} results @param {string} provider @param {string} feature
 */
export function evidenceFor(results, provider, feature) {
  return results.filter((result) => result.provider === provider && result.features.includes(feature));
}

/**
 * @param {Manifest} manifest
 * @param {CaseResult[]} results
 * @param {{ packageJson?: string | URL, lockfile?: string | URL }} [options]
 * @returns {string[]} problems; empty when the manifest matches the results
 */
export function verifyManifest(manifest, results, options = {}) {
  /** @type {string[]} */
  const problems = [];
  if (manifest.schema !== 1) problems.push(`manifest schema ${manifest.schema} is not understood`);
  if (manifest.evidence?.kind !== "mock-server") problems.push('evidence.kind must be "mock-server": no live evidence is recorded');

  const providers = Object.keys(manifest.providers ?? {});
  for (const provider of PROVIDERS) if (!providers.includes(provider)) problems.push(`provider ${provider} is missing from the manifest`);
  for (const provider of providers) if (!PROVIDERS.includes(/** @type {any} */ (provider))) problems.push(`provider ${provider} is not a known provider`);

  // Every feature a case claims to inform must be a feature the manifest states.
  for (const result of results) {
    for (const feature of result.features) {
      if (!FEATURES.includes(feature)) problems.push(`case ${result.case} names unknown feature ${feature}`);
    }
  }

  for (const provider of PROVIDERS) {
    const entry = manifest.providers?.[provider];
    if (!entry) continue;
    if (entry.live !== "unverified") problems.push(`${provider}: live must be "unverified"; no live smoke result is recorded`);
    for (const feature of Object.keys(entry.features ?? {})) {
      if (!FEATURES.includes(feature)) problems.push(`${provider}: unknown feature ${feature}`);
    }
    for (const feature of FEATURES) {
      const claim = entry.features?.[feature];
      const label = `${provider}.${feature}`;
      if (!claim) {
        problems.push(`${label}: missing`);
        continue;
      }
      if (!STATUSES.includes(claim.status)) {
        problems.push(`${label}: status "${claim.status}" is not one of ${STATUSES.join(", ")}`);
        continue;
      }
      const evidence = evidenceFor(results, provider, feature);
      const failing = evidence.filter((result) => result.status === "fail").map((result) => result.case);
      const limits = evidence.filter((result) => result.status === "limitation").map((result) => result.case);
      if (claim.status === "supported") {
        if (evidence.length === 0) problems.push(`${label}: supported, but no conformance case provides evidence`);
        if (failing.length > 0) problems.push(`${label}: supported, but ${failing.join(", ")} failed`);
        if (limits.length > 0) problems.push(`${label}: supported, but ${limits.join(", ")} records a limitation`);
      } else if (claim.status === "unsupported") {
        if (!claim.note) problems.push(`${label}: unsupported needs a note saying what is missing`);
        if (limits.length === 0) problems.push(`${label}: unsupported, but no conformance case records the gap`);
        if (failing.length > 0) problems.push(`${label}: ${failing.join(", ")} failed`);
      } else if (!claim.note) {
        problems.push(`${label}: unverified needs a note saying why`);
      }
    }
  }

  // The manifest names the Easy-LLM release its results are about; it must be the one installed.
  // A published release, pinned exactly: no git ref, no range, no unmerged branch.
  const packageJson = JSON.parse(readFileSync(options.packageJson ?? new URL("../package.json", import.meta.url), "utf8"));
  const wanted = String(packageJson.devDependencies?.["@easy-llm/llm"] ?? "");
  if (!/^\d+\.\d+\.\d+$/.test(wanted)) problems.push(`package.json must pin @easy-llm/llm to an exact published version, not "${wanted}"`);
  else if (manifest.easy_llm?.version !== wanted) problems.push(`manifest is about Easy-LLM ${manifest.easy_llm?.version}, package.json pins ${wanted}`);
  const lock = JSON.parse(readFileSync(options.lockfile ?? new URL("../package-lock.json", import.meta.url), "utf8"));
  const locked = lock.packages?.["node_modules/@easy-llm/llm"];
  if (locked?.version !== wanted) problems.push(`package-lock.json has @easy-llm/llm ${locked?.version ?? "nothing"}, package.json pins ${wanted}`);
  else if (!String(locked.resolved ?? "").startsWith("https://registry.npmjs.org/") || !String(locked.integrity ?? "").startsWith("sha512-")) {
    problems.push("package-lock.json must resolve @easy-llm/llm from the npm registry with an integrity hash");
  }
  return problems;
}
