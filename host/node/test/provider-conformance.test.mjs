// The provider conformance suite as node:test cases: one test per provider and case, so a
// failure is reported by provider and behavior. Also checks the capability manifest against the
// results, and that the verifier really refuses a manifest the results do not back.
// Offline: the real Easy-LLM adapters talk to a mock server on 127.0.0.1.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import * as easyLlm from "@easy-llm/llm";

import { CASES } from "../conformance/cases.mjs";
import { PROVIDERS } from "../conformance/harness.mjs";
import { FEATURES, loadManifest, verifyManifest } from "../conformance/manifest.mjs";
import { formatMarkdown, toJson } from "../conformance/report.mjs";
import { runSuite } from "../conformance/suite.mjs";

const results = await runSuite({ easyLlm });
const manifest = loadManifest();

for (const provider of PROVIDERS) {
  describe(`provider conformance: ${provider}`, () => {
    for (const result of results.filter((r) => r.provider === provider)) {
      test(`${result.case}: ${result.title}`, () => {
        assert.notEqual(result.status, "fail", result.error);
      });
    }
  });
}

describe("provider conformance: coverage", () => {
  test("every case ran for every provider it applies to", () => {
    for (const provider of PROVIDERS) {
      for (const testCase of CASES) {
        const applies = !testCase.providers || testCase.providers.includes(provider);
        const ran = results.some((r) => r.provider === provider && r.case === testCase.id);
        assert.equal(ran, applies, `${provider}/${testCase.id}`);
      }
    }
  });

  test("each of the twelve required behaviors has at least one case", () => {
    const groups = new Set(CASES.map((c) => c.group));
    for (let group = 1; group <= 12; group += 1) assert.ok(groups.has(group), `behavior ${group} has no case`);
  });

  test("results are deterministic: a second run is identical", async () => {
    const again = await runSuite({ easyLlm });
    assert.equal(toJson(again), toJson(results));
  });
});

describe("capability manifest", () => {
  test("matches the conformance results", () => {
    assert.deepEqual(verifyManifest(manifest, results), []);
  });

  test("states every feature for every provider, and nothing is claimed live", () => {
    for (const provider of PROVIDERS) {
      assert.deepEqual(Object.keys(manifest.providers[provider].features).sort(), [...FEATURES].sort(), provider);
      assert.equal(manifest.providers[provider].live, "unverified");
    }
  });

  test("the generated document is reproducible", () => {
    assert.equal(formatMarkdown(manifest, results), formatMarkdown(manifest, results));
  });

  /** @param {(m: any) => void} change */
  const problemsAfter = (change) => {
    const copy = structuredClone(manifest);
    change(copy);
    return verifyManifest(copy, results);
  };

  test("refuses `supported` for a feature a case shows is a limitation", () => {
    const problems = problemsAfter((m) => (m.providers.google.features.text_stream.status = "supported"));
    assert.ok(problems.some((p) => p.startsWith("google.text_stream: supported, but")), problems.join("\n"));
  });

  test("refuses `supported` for a feature no case provides evidence for", () => {
    // `http_status` evidence is tagged on cases; strip the results for one provider to simulate a missing case.
    const stripped = results.filter((r) => !(r.provider === "ollama" && r.features.includes("retry_after")));
    const problems = verifyManifest(manifest, stripped);
    assert.ok(problems.some((p) => p === "ollama.retry_after: supported, but no conformance case provides evidence"), problems.join("\n"));
  });

  test("refuses `supported` when a case fails", () => {
    const broken = results.map((r) => (r.provider === "openai" && r.case === "http-status" ? { ...r, status: /** @type {const} */ ("fail") } : r));
    const problems = verifyManifest(manifest, broken);
    assert.ok(problems.some((p) => p.startsWith("openai.http_status: supported, but http-status failed")), problems.join("\n"));
  });

  test("refuses `unsupported` when no case records the gap", () => {
    const problems = problemsAfter((m) => {
      m.providers.anthropic.features.late_events_ignored = { status: "unsupported", note: "made up" };
    });
    assert.ok(problems.some((p) => p.startsWith("anthropic.late_events_ignored: unsupported, but no conformance case records the gap")), problems.join("\n"));
  });

  test("refuses a missing note, a missing feature, an unknown status and a live claim", () => {
    assert.ok(problemsAfter((m) => delete m.providers.openai.features.usage_stream.note).some((p) => p.includes("unverified needs a note")));
    assert.ok(problemsAfter((m) => delete m.providers.openai.features.images).some((p) => p === "openai.images: missing"));
    assert.ok(problemsAfter((m) => (m.providers.openai.features.images.status = "yes")).some((p) => p.includes('status "yes"')));
    assert.ok(problemsAfter((m) => (m.providers.openai.live = "verified")).some((p) => p.includes("live must be")));
  });

  test("is about the Easy-LLM commit that is installed from", () => {
    assert.ok(problemsAfter((m) => (m.easy_llm.ref = "0".repeat(40))).some((p) => p.includes("package.json pins")));
  });
});

describe("what the suite found, held as facts", () => {
  const status = (/** @type {string} */ provider, /** @type {string} */ feature) => manifest.providers[provider].features[feature].status;

  test("Google streaming completion is unsupported: its stream never carries verified completion", () => {
    assert.equal(status("google", "text_stream"), "unsupported");
    assert.equal(status("google", "finish_reason_stream"), "unsupported");
  });

  test("no tool, image, option or structured-output support is claimed for any provider", () => {
    for (const provider of PROVIDERS) {
      for (const feature of ["tool_definitions", "tool_call_history", "images", "generation_options", "structured_output"]) {
        assert.equal(status(provider, feature), "unsupported", `${provider} ${feature}`);
      }
    }
  });
});
