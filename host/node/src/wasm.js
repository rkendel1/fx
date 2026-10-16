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
 * The exports of a module built from the shared ABI (`rust/wasm-abi`). The prefix is the
 * module's own: `fx` for the FX host session, `chip` for Chip's.
 * @typedef {Record<string, any> & { memory: WebAssembly.Memory }} Exports
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

/**
 * A session driven through a JSON message protocol over the shared WebAssembly ABI. Every
 * call copies bytes in, runs the module, and copies the JSON response out. The module
 * reaches nothing; this class is the only thing that moves data across the boundary.
 */
export class JsonSession {
  #exports;
  #handle;
  #prefix;
  #version;

  /**
   * @param {Exports} exports
   * @param {number} handle
   * @param {string} prefix the module's export prefix
   * @param {number} version the protocol version added to commands
   */
  constructor(exports, handle, prefix, version) {
    this.#exports = exports;
    this.#handle = handle;
    this.#prefix = prefix;
    this.#version = version;
  }

  /**
   * Starts the session from its first document.
   * @param {Uint8Array} document exact document bytes (strict decoding depends on them)
   * @returns {Record<string, any>}
   */
  begin(document) {
    return this.#call(`${this.#prefix}_begin`, document);
  }

  /**
   * Applies one command.
   * @param {Record<string, unknown>} command a command object; `v` is added
   * @returns {Record<string, any>}
   */
  command(command) {
    return this.#call(`${this.#prefix}_command`, encoder.encode(JSON.stringify({ v: this.#version, ...command })));
  }

  /**
   * Sends command bytes exactly as given, without adding the protocol version. For hosts
   * that build their own commands, and for testing malformed input.
   * @param {Uint8Array} bytes
   * @returns {Record<string, any>}
   */
  rawCommand(bytes) {
    return this.#call(`${this.#prefix}_command`, bytes);
  }

  /** Releases the session. Safe to call twice. */
  free() {
    if (this.#handle !== 0) {
      this.#exports[`${this.#prefix}_session_free`](this.#handle);
      this.#handle = 0;
    }
  }

  /**
   * @param {string} name the export to call
   * @param {Uint8Array} input
   * @returns {Record<string, any>}
   */
  #call(name, input) {
    if (this.#handle === 0) throw new HostProtocolError("freed", "the session was already freed");
    const exports = this.#exports;
    const prefix = this.#prefix;
    const ptr = input.length > 0 ? exports[`${prefix}_alloc`](input.length) : 0;
    try {
      // Re-read the buffer after allocating: allocation can grow (and detach) the memory.
      if (input.length > 0) new Uint8Array(exports.memory.buffer, ptr, input.length).set(input);
      const length = exports[name](this.#handle, ptr, input.length);
      if (length < 0) throw new HostProtocolError("abi_error", `the module rejected the call (code ${length})`);
      const outPtr = exports[`${prefix}_output_ptr`](this.#handle);
      const bytes = new Uint8Array(exports.memory.buffer, outPtr, length).slice();
      return JSON.parse(decoder.decode(bytes));
    } finally {
      if (input.length > 0) exports[`${prefix}_free`](ptr, input.length);
    }
  }
}

/** One FX attempt, driven through the FX host protocol. */
export class FxSession extends JsonSession {
  /**
   * @param {Exports} exports
   * @param {number} handle
   */
  constructor(exports, handle) {
    super(exports, handle, "fx", PROTOCOL_VERSION);
  }
}

const SUFFIXES = ["abi_version", "protocol_version", "alloc", "free", "session_new", "session_free", "begin", "command", "output_ptr"];

/**
 * Compiles a module and checks it against the shared ABI: no imports, every export for
 * `prefix`, matching ABI and protocol versions.
 * @param {string | URL | Uint8Array | ArrayBuffer} source a path, URL or the module bytes
 * @param {string} prefix the module's export prefix (`fx` or `chip`)
 * @param {{ abi: number, protocol: number }} versions the versions this host speaks
 * @returns {Promise<Exports>}
 */
export async function loadExports(source, prefix, versions) {
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
  const required = ["memory", ...SUFFIXES.map((suffix) => `${prefix}_${suffix}`)];
  const missing = required.filter((name) => !exported.has(name));
  if (missing.length > 0) throw new HostProtocolError("missing_exports", `the module lacks exports: ${missing.join(", ")}`);

  const instance = await WebAssembly.instantiate(module, {});
  const exports = /** @type {Exports} */ (/** @type {unknown} */ (instance.exports));
  if (exports[`${prefix}_abi_version`]() !== versions.abi) {
    throw new HostProtocolError("abi_mismatch", `module ABI ${exports[`${prefix}_abi_version`]()}, host ABI ${versions.abi}`);
  }
  if (exports[`${prefix}_protocol_version`]() !== versions.protocol) {
    throw new HostProtocolError("protocol_mismatch", `module protocol ${exports[`${prefix}_protocol_version`]()}, host protocol ${versions.protocol}`);
  }
  return exports;
}

/**
 * Compiles and validates the FX host module.
 * @param {string | URL | Uint8Array | ArrayBuffer} source a path, URL or the module bytes
 * @returns {Promise<FxModule>}
 */
export async function loadModule(source) {
  return new FxModule(await loadExports(source, "fx", { abi: ABI_VERSION, protocol: PROTOCOL_VERSION }));
}
