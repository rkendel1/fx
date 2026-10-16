// Runs the shared host-conformance fixtures (rust/fx-host/tests/fixtures/conformance)
// against the WebAssembly build. The native Rust runner holds the same files to the same
// expectations; when FX_CONFORMANCE_NATIVE points at its transcript, every response must
// also be identical to the native one.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { test, describe } from "node:test";

import { defaultWasmPath } from "../src/index.js";
import { loadModule } from "../src/wasm.js";

const dir = new URL("../../../rust/fx-host/tests/fixtures/conformance/", import.meta.url);
const cases = readdirSync(dir)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => JSON.parse(readFileSync(new URL(name, dir), "utf8")));

const nativePath = process.env.FX_CONFORMANCE_NATIVE;
const native = nativePath && existsSync(nativePath) ? JSON.parse(readFileSync(nativePath, "utf8")) : undefined;

/** Subset match: objects by key, arrays and scalars exactly, null matches absent, `$` keys are directives. */
function check(expected, actual, path, errors) {
  if (expected && typeof expected === "object" && !Array.isArray(expected)) {
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
      errors.push(`${path}: expected an object`);
      return;
    }
    for (const [key, value] of Object.entries(expected)) {
      if (key.startsWith("$")) continue;
      if (key in actual) check(value, actual[key], `${path}.${key}`, errors);
      else if (value !== null) errors.push(`${path}.${key}: missing`);
    }
  } else if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      errors.push(`${path}: expected ${expected.length} items, got ${Array.isArray(actual) ? actual.length : "none"}`);
      return;
    }
    expected.forEach((item, i) => check(item, actual[i], `${path}[${i}]`, errors));
  } else if (expected !== actual) {
    errors.push(`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function lookup(value, dotted) {
  return dotted.split(".").reduce((v, key) => (v == null ? v : v[key]), value);
}

function exclusions(expected, raw, actual, path, errors) {
  for (const needle of expected.$excludes_all ?? []) {
    if (raw.includes(needle)) errors.push(`${path}: the response contains a forbidden value`);
  }
  if (expected.$excludes) {
    const scope = JSON.stringify(lookup(actual, expected.$excludes.at));
    for (const needle of expected.$excludes.values) {
      if (scope.includes(needle)) errors.push(`${path}: ${expected.$excludes.at} contains a forbidden value`);
    }
  }
}

const module = await loadModule(defaultWasmPath());

describe("host conformance fixtures on WebAssembly", () => {
  assert.ok(cases.length >= 20, "fixture corpus unexpectedly small");

  for (const fixture of cases) {
    if (!fixture.targets.includes("wasm")) continue;
    test(fixture.name, () => {
      const session = module.newSession(fixture.support ?? 0);
      const transcript = [];
      const errors = [];
      const encoder = new TextEncoder();
      try {
        const exchange = (label, response, expected) => {
          // The session API parses JSON; re-serialize to run the byte-level exclusion checks.
          const raw = JSON.stringify(response);
          check(expected, response, `${fixture.name} ${label}`, errors);
          exclusions(expected, raw, response, `${fixture.name} ${label}`, errors);
          transcript.push(response);
        };
        const request = fixture.request_raw !== undefined ? encoder.encode(fixture.request_raw) : encoder.encode(JSON.stringify(fixture.request));
        exchange("begin", session.begin(request), fixture.begin);
        fixture.steps.forEach((step, i) => {
          let response;
          if (step.send_raw !== undefined) {
            response = rawCommand(session, step.send_raw);
          } else {
            response = session.command(step.send);
          }
          exchange(`step ${i}`, response, step.expect);
        });
      } finally {
        session.free();
      }
      assert.deepEqual(errors, []);
      if (native && fixture.targets.includes("native")) {
        assert.deepEqual(transcript, native[fixture.name], "the WebAssembly responses differ from the native responses");
      }
    });
  }

  test("every fixture that runs natively also runs on WebAssembly unless it says otherwise", () => {
    for (const fixture of cases) {
      assert.ok(fixture.behavior && fixture.targets.length > 0, fixture.name);
    }
    if (native) {
      for (const fixture of cases.filter((c) => c.targets.includes("native"))) {
        assert.ok(fixture.name in native, `${fixture.name} missing from the native transcript`);
      }
    } else {
      process.stderr.write("note: FX_CONFORMANCE_NATIVE not set, so responses were not compared with the native run\n");
    }
  });
});

/** Sends raw command bytes, bypassing the session's JSON wrapper, to exercise malformed input. */
function rawCommand(session, text) {
  const bytes = new TextEncoder().encode(text);
  return session.rawCommand(bytes);
}
