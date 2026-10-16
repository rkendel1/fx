// @ts-check
// Loads the FX host WebAssembly module and wraps its C ABI (rust/fx-host/src/abi.rs).
//
// The module imports nothing. It is instantiated with an empty import object, and a
// module that asks for any import is refused, so it cannot be handed filesystem,
// process, network, clock or environment access by accident.

import { readFile } from "node:fs/promises";

/** The ABI and protocol versions this host speaks. */
export const ABI_VERSION = 1;
export const PROTOCOL_VERSION = 1;

/** Request features the provider path can carry (bit set; 0 means text only). */
export const SupportFlags = Object.freeze({
  images: 1,
  toolSchemas: 2,
  toolHistory: 4,
  toolChoice: 8,
  providerTools: 16,
  generationOptions: 32,
  responseFormat: 64,
});

/** The host drove the protocol incorrectly, or the module misbehaved. Not a provider failure. */
export class HostProtocolError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "HostProtocolError";
    this.code = code;
  }
}

/**
 * @typedef {{
 *   memory: WebAssembly.Memory,
 *   fx_abi_version: () => number,
 *   fx_protocol_version: () => number,
 *   fx_alloc: (len: number) => number,
 *   fx_free: (ptr: number, len: number) => void,
 *   fx_session_new: (flags: number) => number,
 *   fx_session_free: (handle: number) => void,
 *   fx_begin: (handle: number, ptr: number, len: number) => number,
 *   fx_command: (handle: number, ptr: number, len: number) => number,
 *   fx_output_ptr: (handle: number) => number,
 * }} Exports
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * One compiled, validated module. Create sessions from it; each session is an
 * independent attempt with its own state.
 */
export class FxModule {
  /** @param {Exports} exports */
  constructor(exports) {
    this.exports = exports;
  }

  /**
   * @param {number} [flags] request features the provider path can carry
   * @returns {FxSession}
   */
  newSession(flags = 0) {
    const handle = this.exports.fx_session_new(flags >>> 0);
    if (handle === 0) throw new HostProtocolError("session_unavailable", "the module could not create a session");
    return new FxSession(this.exports, handle);
  }
}

/** One attempt, driven through the JSON protocol. */
export class FxSession {
  #exports;
  #handle;

  /**
   * @param {Exports} exports
   * @param {number} handle
   */
  constructor(exports, handle) {
    this.#exports = exports;
    this.#handle = handle;
  }

  /**
   * Starts the attempt from the raw FX request document.
   * @param {Uint8Array} request exact document bytes (strict decoding depends on them)
   * @returns {Record<string, any>}
   */
  begin(request) {
    return this.#call(this.#exports.fx_begin, request);
  }

  /**
   * Applies one command.
   * @param {Record<string, unknown>} command a command object; `v` is added
   * @returns {Record<string, any>}
   */
  command(command) {
    return this.#call(this.#exports.fx_command, encoder.encode(JSON.stringify({ v: PROTOCOL_VERSION, ...command })));
  }

  /**
   * Sends command bytes exactly as given, without adding the protocol version. For hosts
   * that build their own commands, and for testing malformed input.
   * @param {Uint8Array} bytes
   * @returns {Record<string, any>}
   */
  rawCommand(bytes) {
    return this.#call(this.#exports.fx_command, bytes);
  }

  /** Releases the session. Safe to call twice. */
  free() {
    if (this.#handle !== 0) {
      this.#exports.fx_session_free(this.#handle);
      this.#handle = 0;
    }
  }

  /**
   * @param {(handle: number, ptr: number, len: number) => number} fn
   * @param {Uint8Array} input
   * @returns {Record<string, any>}
   */
  #call(fn, input) {
    if (this.#handle === 0) throw new HostProtocolError("freed", "the session was already freed");
    const exports = this.#exports;
    const ptr = input.length > 0 ? exports.fx_alloc(input.length) : 0;
    try {
      // Re-read the buffer after allocating: allocation can grow (and detach) the memory.
      if (input.length > 0) new Uint8Array(exports.memory.buffer, ptr, input.length).set(input);
      const length = fn(this.#handle, ptr, input.length);
      if (length < 0) throw new HostProtocolError("abi_error", `the module rejected the call (code ${length})`);
      const outPtr = exports.fx_output_ptr(this.#handle);
      const bytes = new Uint8Array(exports.memory.buffer, outPtr, length).slice();
      return JSON.parse(decoder.decode(bytes));
    } finally {
      if (input.length > 0) exports.fx_free(ptr, input.length);
    }
  }
}

const REQUIRED = [
  "memory",
  "fx_abi_version",
  "fx_protocol_version",
  "fx_alloc",
  "fx_free",
  "fx_session_new",
  "fx_session_free",
  "fx_begin",
  "fx_command",
  "fx_output_ptr",
];

/**
 * Compiles and validates the module.
 * @param {string | URL | Uint8Array | ArrayBuffer} source a path, URL or the module bytes
 * @returns {Promise<FxModule>}
 */
export async function loadModule(source) {
  const bytes =
    source instanceof Uint8Array
      ? source
      : source instanceof ArrayBuffer
        ? new Uint8Array(source)
        : await readFile(source);
  const module = await WebAssembly.compile(/** @type {BufferSource} */ (bytes));

  const imports = WebAssembly.Module.imports(module);
  if (imports.length > 0) {
    const names = imports.map((entry) => `${entry.module}.${entry.name}`).join(", ");
    throw new HostProtocolError("unexpected_imports", `the module requests host imports (${names}); refusing to grant them`);
  }
  const exported = new Set(WebAssembly.Module.exports(module).map((entry) => entry.name));
  const missing = REQUIRED.filter((name) => !exported.has(name));
  if (missing.length > 0) throw new HostProtocolError("missing_exports", `the module lacks exports: ${missing.join(", ")}`);

  const instance = await WebAssembly.instantiate(module, {});
  const exports = /** @type {Exports} */ (/** @type {unknown} */ (instance.exports));
  if (exports.fx_abi_version() !== ABI_VERSION) {
    throw new HostProtocolError("abi_mismatch", `module ABI ${exports.fx_abi_version()}, host ABI ${ABI_VERSION}`);
  }
  if (exports.fx_protocol_version() !== PROTOCOL_VERSION) {
    throw new HostProtocolError("protocol_mismatch", `module protocol ${exports.fx_protocol_version()}, host protocol ${PROTOCOL_VERSION}`);
  }
  return new FxModule(exports);
}
