# Audit 04: Embedding surfaces, build, packaging, CI

Scope: `build.zig`, `src/main.zig` exports, `src/napi_core_main.zig`, `src/napi_fetch_state.zig`, `src/wasm_core_main.zig`, `src/wasm_term_main.zig`, test and benchmark export roots, `src/acp/*`, `sdk/**`, `.github/**`, `scripts/**`, `benchmarks/**`, and a survey of `tests/`. Line numbers refer to commit `255c6cf`. ✓ marks claims re-verified while writing.

## 1. Headline findings

1. **Every embedding surface is an ACP agent server, not an inference API.** `fx-core.wasm` runs `acp_server.run()` over WASI stdio (`wasm_core_main.zig:32-56`); `libfx.node` runs `acp_server.runWithTransport()` on a native thread over byte queues (`napi_core_main.zig:438-480`); the JS SDK speaks newline-delimited ACP JSON-RPC to both (`sdk/fx-sdk.js:933-1129`). No public API takes a request and returns an inference stream.
2. **The host transport is hard-wired to Vercel AI Gateway.** `host_stream_provider.stream()` always sends the Gateway header set and parses with `consumeGatewaySseStream` (`host_stream_provider.zig:59-109`).
3. **No surface spawns the CLI.** The native binary re-execs itself for hosted terminal modes (`--fx-internal-terminal-host`, `-launcher`, `-control`, `-tmux-launcher`, `-tmux-capture`; `main.zig:2744-2840`), which is Compute territory.
4. **The WASM surfaces are WASI commands, not reactor libraries.** They need the `wasi_snapshot_preview1` shim plus the `"fx"` import namespace, JSPI (`WebAssembly.Suspending`/`promising`), and are `single_threaded` (`build.zig:350`). Filesystem imports are stubbed `unavailable` (`fx-sdk.js:739-760`).
5. **N-API is less isolated than `sdk/NAPI.md` states.** ✓ It wires the native `builtin_gateway.provider` catalog, CLI catalog, credits and web search (`napi_core_main.zig:438-443`), so `initialize` performs native HTTP through `gateway_client` (`acp/server.zig:1251-1261`). It also uses the native durable session store under `home` (`acp/sessions.zig:161-164`). Only the agent stream goes through the JS fetch bridge.
6. **Method gaps.** ✓ `session/remove` returns "Method not found" on native and N-API (`acp/server.zig:988-995`) although `session.remove()` in the SDK calls it (`fx-sdk.js:1067-1072`). On WASM, `session/resume` and `session/close` are not implemented although `initialize` advertises them (`server.zig:963-975`, `types.zig:180-192`).

## 2. Artifacts

| Artifact | Root | Build | Exports |
| --- | --- | --- | --- |
| `zig-out/bin/fx` | `src/main.zig` | default install | C `main` (`main.zig:2705`) |
| test binary | `src/main.zig` | `zig build test` | all in-file tests; `FX_TEST_PRODUCT_EXE` |
| `fx-core.wasm` | `src/wasm_core_main.zig` | `-Dwasm-surface=core`, forced ReleaseSmall (`build.zig:349`) | `_start`, `memory` |
| `fx-term.wasm` | `src/wasm_term_main.zig` | `-Dwasm-surface=term` | `_start`, `memory` |
| `libfx.node` | `src/napi_core_main.zig` | `-Dnapi-surface=core`, forced ReleaseSafe (`build.zig:392`) | `napi_register_module_v1` |
| `json-schema-corpus`, `mcp-stdio-dispatcher-driver` | `tests/...` + `src/mcp_test_exports.zig` | dedicated steps | test drivers |
| three benchmark executables | `benchmarks/*.zig` + `src/benchmark_exports.zig` | dedicated steps | |
| PGSO bitcode | as above | `pgso-ir` | |
| `terminal-client-fixture` | `src/terminal_client_fixture.zig` | built ad hoc by `tests/e2e/terminal-host.test.ts:465-480`, not in `build.zig` | |

## 3. N-API surface

Exports (`napi_core_main.zig:941-961`): `libfxApiVersion = 2`, `createCore({apiKey, model?, home, workspaceRoot, gatewayChatUrl?})`, `writeCore`, `closeCore`, `drainCore`, `takeCoreFetch`, `coreFetchActive`, `startCoreFetchResponse`, `pushCoreFetchResponse`, `finishCoreFetch`, `failCoreFetch`, `abortCoreFetch`, `coreExited`, `coreExitCode`, `destroyCore`.

- Threading: one lazily created process-wide `std.Io.Threaded` (`ensureThreadedIo`, :540-553); one native thread per runtime that never calls N-API; JS polls with `setInterval(..., 2)` (`sdk/node.js:205-229`); per-queue mutexes and condition variables; 64 runtime slots.
- Fetch bridge: pure state machine in `napi_fetch_state.zig` (phases idle, cancel_pending, request_pending, awaiting_response, streaming, terminal, shutdown; `decide()` returns applied/stale/no_request/cancelled/unavailable/shutting_down; 3 tests). Monotonic positive handles; **one fetch in flight per runtime**; request handed to JS as JSON with a base64 body.
- Cancel: ACP `session/cancel` sets the session flag; JS `turn.cancel()` also aborts the host fetch (`fx-sdk.js:1084-1091`, `node.js:146-149`).
- Errors: `LIBFX_INVALID_ARGUMENT`, `LIBFX_NATIVE_LIMIT`, `_BACKPRESSURE`, `_CLOSED`, `_OOM`, `_THREAD`, `_IO`, `LIBFX_NAPI`; JS adds `LIBFX_NATIVE_UNAVAILABLE`, `LIBFX_JSPI_REQUIRED`. ACP JSON-RPC error codes are lost in JS (`fx-sdk.js:985`).
- Security: type-tagged handles, bounded inputs, native tools and ACP MCP disabled, canonical-or-loopback Gateway URL. The API key is not zeroized.
- Observed: all 12 N-API SDK scripts pass against a locally built addon ([../BASELINE.md](../BASELINE.md)).

## 4. WASM surface

Host imports (module `"fx"`, implemented in `sdk/fx-sdk.js:766-797`):

| Import | Purpose | Target owner |
| --- | --- | --- |
| `fx_http_stream_{open,status,next,close}` | streaming fetch (status 1/0/-1/-2; next n/0/-1/-2/-3) | FX keeps the polling ABI shape; payload semantics change |
| `fx_http_request` | buffered fetch (catalog 4 MiB cap, OAuth) | Easy-LLM |
| `fx_session_{load,commit,list,remove}` | host session store with revision CAS | Chip |
| `fx_oauth_session_{load,commit,remove}` | Vercel login session | Easy-LLM (Vercel parts removed) |
| `fx_config_{get,set}`, `fx_prompt_history_*` | host config and history | Chip / shell |
| `fx_open_url` | login URLs | Easy-LLM |
| `fx_workspace_{available,info,exec}` | host command execution (≤64 KiB, 1–30,000 ms) | Compute |
| `fx_term_size`, `fx_term_poll_input` | browser TUI | shell |

Memory rule today: Zig always allocates and passes ptr/cap; the host copies; negative returns signal overflow and Zig retries with a larger buffer; no guest memory is retained across suspension. This rule is sound and is kept in the target ABI.

## 5. JS SDK

Exports: `fxSdkApiVersion = 1`, `supportsJspi`, `encodeXtermKeyEvent`, `xtermAdapter`, `createFxTerminal`, `createFxAgent`; `node.js`/`browser.js` add `libfxApiVersion = 2` and backend selection (`auto|native|wasm`, `nativeAddon`, `home`, `workspaceRoot`). Agent object: `createSession`, `openSession`, `listSessions`, `close`, `abort`, `exited`; session `prompt(input, {signal})` returns an async iterator of raw ACP `session/update` payloads. Event types: `runtime.*`, `acp.*`, `permission.*`, `config.*`, `history.*`, `terminal.*`.

Everything is ACP-shaped. **The SDK exposes no inference-level API.**

## 6. ACP server

Methods (`server.zig:47-73`, dispatch :936-997): `initialize`, `session/new`, `session/load`, `session/resume`, `session/close`, `session/list`, `session/remove` (fx extension; WASM only), `session/prompt`, `session/set_config_option`, `session/set_mode`, `session/cancel`. Server→client: `session/request_permission`, `elicitation/create`, `elicitation/complete`. Updates: `agent_message_chunk`, `user_message_chunk`, `tool_call`, `tool_call_update`, `available_commands_update`, `session_info_update`. **Reasoning is never surfaced** (no `agent_thought_chunk`). Stop reasons `end_turn, max_output_tokens, max_model_turns, refused, cancelled` (`types.zig:62-79`) differ from ACP's standard spellings.

## 7. CI and release

| Workflow | Vercel usage | Disposition |
| --- | --- | --- |
| `ci.yml` | `AI_GATEWAY_API_KEY` secret for the main-only live ACP job (:375); blanks `VERCEL_OIDC_TOKEN` | REBUILD: drop the live job or point it at the optional Easy-LLM smoke |
| `full-ci.yml` | blanks `AI_GATEWAY_API_KEY`, `VERCEL_OIDC_TOKEN` (:36-37, 111-112) | REBUILD: keep the four-runner matrix |
| `bench.yml` | none (the `AGENTS.md` claim that results upload to Vercel Blob does not match the 46-line workflow) | keep for the shell; add a core benchmark |
| `binary-size.yml` | none | keep, retarget |
| `pgso-macos-arm64.yml` | blanks keys | shell-only |
| `release.yml` | `BLOB_READ_WRITE_TOKEN` → `blob.vercel-storage.com` (:141-172) | REBUILD: GitHub Release only, or a neutral host |
| `dev-release.yml` | Blob uploads and `FX_WEB_DEPLOY_HOOK_URL` (:107-208) | REBUILD/REMOVE |
| `cdn-backfill.yml` | Blob uploads | REMOVE |
| `prepare-release.yml` | calls `https://ai-gateway.vercel.sh/v3/ai/language-model` with `AI_GATEWAY_API_KEY` to draft the changelog (:70, 133-140) | REBUILD: use Easy-LLM or a human draft |
| `publish-libfx.yml` | npm OIDC trusted publishing (npm's, not Vercel's) | keep the pattern; it duplicates `sdk/scripts/package-libfx.mjs` inline |

`sdk/scripts/package-term-demo.mjs` writes a `vercel.json` for a Vercel-hosted demo (:44-82).

## 8. Consumers

No reference to Chip, Easy-LLM, Compute (as a product), Attn or PAX anywhere in the repository. The only consumer contracts present are the `fx` CLI, ACP clients and npm `libfx`.

## 9. Tests

- SDK: only `test-core-live.mjs` needs a live credential and it is in no CI lane. N-API lane (12 scripts) and WASM lane (`test-core`, `test-core-cancel`, `test-core-home-unavailable`, `test-term*`, `sdk/node` term tests) are deterministic with mock fetch or a local HTTP server. `test-sdk.mjs` is unreferenced legacy.
- E2E: 59 `*.test.ts` files (tui 29, web 6, mcp 4, file 2, single files for acp, ask, auth, auto, ci, cli, config, context, gateway, notifications, oauth, permission, prompt, session, terminal, tmux, vision, yolo). Live: `context-limits-live`, `web-fetch-live`, `web-search-live`, and the full ACP job on main.
- Evals: 22 Bun scenarios through `fx ask --json`; all need a live key; not in CI.
- `tests/json-schema`: JSON-Schema-Test-Suite against fx's MCP validator; not wired into any workflow.
