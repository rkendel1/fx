// The WebAssembly ABI as a host sees it: versions, memory handling, independence.

import assert from "node:assert/strict";
import { before, describe, test } from "node:test";

import { defaultWasmPath } from "../src/index.js";
import { ABI_VERSION, HostProtocolError, PROTOCOL_VERSION, loadModule } from "../src/wasm.js";

const RID = "00112233445566778899aabbccddeeff";
const doc = (text) => JSON.stringify({ v: 1, model: "m", messages: [{ role: "user", parts: [{ type: "text", text }] }], correlation: { request_id: RID } });
const bytes = (text) => new TextEncoder().encode(text);

let module;
before(async () => {
  module = await loadModule(defaultWasmPath());
});

describe("WebAssembly ABI", () => {
  test("reports the versions the host checked", () => {
    assert.equal(module.exports.fx_abi_version(), ABI_VERSION);
    assert.equal(module.exports.fx_protocol_version(), PROTOCOL_VERSION);
  });

  test("an empty request is rejected as invalid without invoking anything", () => {
    const session = module.newSession();
    try {
      const response = session.begin(new Uint8Array(0));
      assert.equal(response.status, "done");
      assert.equal(response.report.outcome.kind, "invalid_request");
      assert.equal(response.report.diagnostics.starts, 0);
    } finally {
      session.free();
    }
  });

  test("a large request survives memory growth", () => {
    const session = module.newSession();
    try {
      const response = session.begin(bytes(doc("x".repeat(3 * 1024 * 1024))));
      assert.equal(response.status, "need_invoke");
      assert.equal(response.request.messages[0].parts[0].text.length, 3 * 1024 * 1024);
    } finally {
      session.free();
    }
  });

  test("a freed session cannot be used, and freeing twice is harmless", () => {
    const session = module.newSession();
    session.free();
    session.free();
    assert.throws(() => session.begin(bytes(doc("hi"))), (error) => error instanceof HostProtocolError && error.code === "freed");
  });

  test("sessions in one instance are independent and may interleave", () => {
    const a = module.newSession();
    const b = module.newSession();
    try {
      assert.equal(a.begin(bytes(doc("a"))).status, "need_invoke");
      assert.equal(b.begin(bytes(doc("b"))).status, "need_invoke");
      assert.equal(a.command({ cmd: "invoke_result", ok: true }).status, "ready");
      // b was not told the provider was invoked, so it still refuses to step.
      assert.equal(b.command({ cmd: "step" }).error.code, "bad_state");
      assert.equal(a.command({ cmd: "step" }).status, "need_input");
    } finally {
      a.free();
      b.free();
    }
  });

  test("creating and freeing many sessions does not exhaust memory", () => {
    for (let i = 0; i < 500; i += 1) {
      const session = module.newSession();
      session.begin(bytes(doc("x".repeat(1024))));
      session.free();
    }
    assert.ok(module.exports.memory.buffer.byteLength < 256 * 1024 * 1024);
  });
});
