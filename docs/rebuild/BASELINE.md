# Phase A: Repository baseline

This is the state of the repository the decomposition was performed against. Every later document in `docs/rebuild/` is evidence about this exact tree.

## Source of truth

| Item | Value |
| --- | --- |
| Repository | `rkendel1/fx` (fork; canonical upstream is `vercel-labs/fx` per `AGENTS.md`) |
| Branch audited | `claude/magical-volta-0f78co`, branched from `main` |
| Commit audited | `255c6cf125034baad48c99bd618783d63dab7df1` ("Merge pull request #218 from vercel-labs/fazxes/stabilize-mcp-launch-evidence") |
| Working tree | Clean before this PR (`git status` reported nothing to commit) |
| Submodules | None (`git submodule status` is empty) |
| Tracked files | 784 (excluding the `docs/rebuild/` files this PR adds) |
| Product version | `0.0.4` (`src/main.zig:6`, `pub const version`) |
| `build.zig.zon` version | `0.0.0` placeholder, `minimum_zig_version = "0.16.0"`, `.dependencies = .{}` |

## Language, toolchain, targets

- Zig 0.16.0. The audit used the official 0.16.0 toolchain from the `ziglang` PyPI wheel because `ziglang.org` is blocked by this environment's network policy. CI uses `mlugg/setup-zig@v2` with version `0.16.0` (`.github/workflows/full-ci.yml:41-45`).
- No Zig package dependencies. No Node.js runtime dependency for the binary.
- JavaScript lives only in `sdk/` (the `libfx` npm package, zero runtime dependencies; `sdk/node/package.json` has the dev dependency `@xterm/headless@6.0.0`) and in Bun test harnesses under `tests/`.
- Python 3 is used by `scripts/` (PGSO, binary size) and `benchmarks/`.
- Supported native targets in CI: `ubuntu-24.04` x86_64, `ubuntu-24.04-arm` aarch64, `macos-15-intel` x86_64, `macos-15` aarch64 (`full-ci.yml:25-33`). Release cross-builds linux x86_64/aarch64 and macOS x86_64; macOS arm64 is produced by the PGSO workflow (`release.yml`).
- WebAssembly targets: `wasm32-wasi`, `single_threaded`, forced `ReleaseSmall` (`build.zig:311-366`).

## Dependencies

| Scope | Declared dependencies | Evidence |
| --- | --- | --- |
| Zig build | none | `build.zig.zon` `.dependencies = .{}` |
| `sdk/package.json` (`libfx`) | none | no `dependencies` key |
| `sdk/node/package.json` | `@xterm/headless@6.0.0` (dev) | lockfile is 22 lines |
| `tests/e2e/package.json`, `tests/evals/package.json` | `@types/bun`, `typescript` (dev) | |
| `tests/e2e/conformance/package.json` | `@modelcontextprotocol/conformance@0.2.0-alpha.10` (dev) | 1,532-line lockfile; no `ai`, `@ai-sdk/*` or Vercel package |

**No Vercel AI SDK package (`ai`, `@ai-sdk/*`) is a dependency anywhere.** The Vercel coupling is at the wire-protocol, endpoint, identity and infrastructure level, implemented natively in Zig. See [VERCEL_TRACE.md](VERCEL_TRACE.md).

## Public surfaces

| Surface | Root | Entry | Notes |
| --- | --- | --- | --- |
| `fx` CLI/TUI binary | `src/main.zig` | exported C `main` (`main.zig:2705`) | 22 top-level commands (`src/builtins/commands.zig:22-300`), 42 slash command kinds (`src/core/slash_commands/command_specs.zig:33-76`) |
| `fx acp` | `src/acp/server.zig` | `run` (`:494`) | ACP JSON-RPC 2.0 agent server over stdio |
| `libfx.node` (N-API) | `src/napi_core_main.zig` | `napi_register_module_v1` (`:941-961`) | `libfxApiVersion = 2`; runs the ACP server on a native thread |
| `fx-core.wasm` | `src/wasm_core_main.zig` | WASI `_start` | ACP server over WASI stdio; imports from the `"fx"` namespace |
| `fx-term.wasm` | `src/wasm_term_main.zig` | WASI `_start` → `runWasmTerminal` (`main.zig:2709`) | Interactive TUI in the browser |
| npm `libfx` | `sdk/node.js`, `sdk/browser.js`, `sdk/fx-sdk.js` | `createFxAgent`, `createFxTerminal`, `supportsJspi`, `xtermAdapter`, `encodeXtermKeyEvent` | Agent-level API only; no inference-level API |
| Internal re-exec modes | `src/main.zig:2744-2840` | `--fx-internal-terminal-host`, `-launcher`, `-control`, `-tmux-launcher`, `-tmux-capture` | The binary re-execs itself for hosted terminals; no surface spawns the CLI |

There is no C ABI other than the N-API module, and no exported inference function on any surface.

## Build, generated code, CI, release

- `build.zig` (448 lines) steps: install, `run`, `test`, `run-json-schema-corpus`, `run-mcp-stdio-dispatcher-e2e`, three benchmark executables, `pgso-ir`, `fx-core-wasm`, `fx-term-wasm`, `libfx-napi`. Build options: `git_commit`, `app_version` (parsed from `src/main.zig`), `update_channel`, `wasm_surface`, `napi_surface`.
- Generated code checked in: `src/core/shared/unicode_display_data.zig` (8,945 lines of Unicode width tables). No code generation runs at build time.
- Workflows: `ci.yml`, `full-ci.yml`, `bench.yml`, `binary-size.yml`, `pgso-macos-arm64.yml`, `release.yml`, `dev-release.yml`, `publish-libfx.yml`, `prepare-release.yml`, `cdn-backfill.yml`. Details and Vercel usage are in [audit/04-embedding-build-ci.md](audit/04-embedding-build-ci.md).

## Consumers

A repository-wide search (`grep -rniE '\bchip\b|easy-?llm|\battn\b|\bpax\b'`, plus `compute` in a product sense) finds **no reference to Chip, Easy-LLM, Compute, Attn or PAX**. The only consumers visible from this repository are:

1. The `fx` product shell itself (CLI, TUI, `fx ask`, `fx acp`), which is the sole caller of the inference seam.
2. ACP clients (editors) through `fx acp`.
3. npm `libfx` users through `createFxAgent()` / `createFxTerminal()`.
4. Test harnesses (`tests/e2e`, `tests/evals`, `sdk/tests`).

The target owners named in the rebuild brief exist outside this workspace. Their interfaces are therefore not evidence here; where the plan depends on them, it says so in [DECISIONS.md](DECISIONS.md).

## Observed test and build status at the audited commit

All runs below were made in this container (Linux x86_64, running as root) with the 0.16.0 toolchain. The fork has no GitHub Actions history (`list_workflow_runs` on `rkendel1/fx` returned zero runs), so there is no CI result for this commit to compare against.

| Check | Command | Result |
| --- | --- | --- |
| Debug build | `zig build` | **Pass**, 28 s, `zig-out/bin/fx` 171 MiB unstripped Debug |
| Binary smoke | `./zig-out/bin/fx --version`, `help`, `status --json` | **Pass**; default model reported as `zai/glm-5.2`, `auth: "missing"` with Vercel AI Gateway help text |
| No-credential ask | `fx ask --json "hi"` (empty `HOME`, no key) | Exit 1, `{"error":"MissingCredentials",...}`, stderr "Fx needs access to Vercel AI Gateway..." |
| Fake-gateway ask | `fx ask --json` against [tools/fake_gateway.py](tools/fake_gateway.py) | **Pass**, plain text and one full tool round trip; see [evidence/observed-wire.md](evidence/observed-wire.md) |
| Unit tests (Debug) | `zig build test` | **8,371 passed, 17 skipped, 11 failed of 8,399**; 4 leaks reported, 4 m 35 s |
| WASM core build | `zig build -Dwasm-surface=core -Doptimize=ReleaseSmall` | **Pass**, `fx-core.wasm` 2,224,753 bytes |
| N-API build | `zig build -Dnapi-surface=core` | **Pass**, `libfx.node` 7,709,080 bytes |
| N-API SDK lane | the 12 scripts listed in `sdk/tests/test-node-napi.mjs`, run individually against the built addon | **12/12 pass** |
| WASM SDK lane | `node --experimental-wasm-jspi sdk/tests/test-core.mjs` | **Not run**: the container has Node 22, whose JSPI API differs; CI uses Node 24. Not a product failure. |
| E2E (Bun/tmux) | not run | The full deterministic suite is CI-only by repository policy (`AGENTS.md`, "Full CI on Feature Branches"). |
| Evals | not run | Require a live `AI_GATEWAY_API_KEY`. |

### The 11 failing unit tests

None is in the inference path. All are in subsystems whose behavior depends on process privileges, process groups or timing, which differ in this root-owned container:

| Test | Module | Likely cause (unconfirmed) |
| --- | --- | --- |
| `McpRuntime cancels blocked stdio discovery without exposing partial state` | `core/mcp/mcp_runtime.zig` | timing in container |
| `caller cancellation interrupts blocked candidate connection` (expected `.disconnected`, found `.failed`) | `core/mcp/mcp_runtime.zig` | timing |
| `McpRuntime async discovery publishes tool names only after the full pass` | `core/mcp/mcp_runtime.zig` | timing |
| `McpRuntime continues discovery after one server times out` | `core/mcp/mcp_runtime.zig` | timing |
| `first write traces and maps shared layout failure` (expected `DurableLayoutFailed`) | `core/session/session_store.zig` | root bypasses the permission denial the test sets up; also the source of the 4 leaks |
| `history page maps missing unsafe unavailable unsupported and corrupt sessions distinctly` | `core/session/session_store.zig` | root bypasses permissions |
| `timeout terminates foreground process group descendants` and four `natural command completion ... / cancellation preserves grace ...` tests | `core/permissions/sandbox.zig` | process-group and subreaper behavior in the container |

These are recorded as **pre-existing environment-specific failures**, not regressions, and are not waived: R1 of the roadmap re-establishes the baseline on Full CI runners before any behavior is frozen ([ROADMAP.md](ROADMAP.md)).

### Baseline performance contracts already in the repository

- Startup latency: 2 ms raw wall clock on Linux CI for every benchmarked command (`AGENTS.md`, "Benchmarks"; `benchmarks/check_budgets.py`). `FX_BENCH=1` exits after dispatch (`src/core/app/app_entry_runtime.zig:173-197`).
- Binary size: 7.800 MiB production ceiling on macOS arm64 PGSO; informational warning at 52,429 bytes growth per PR (`binary-size.yml`).
- No inference-latency or streaming-throughput benchmark exists. The roadmap adds one for the new core.
