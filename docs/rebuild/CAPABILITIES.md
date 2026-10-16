# Capability ledger

Every capability ID used in [inventory/ownership_rules.tsv](inventory/ownership_rules.tsv) and [inventory/symbol_overrides.tsv](inventory/symbol_overrides.tsv) is defined here. The generator's `--check` mode fails if an ID is used but not defined in this file, so the file-level and declaration-level inventories always resolve to a ledger entry.

Disposition vocabulary (from the brief): **KEEP** essential and well-bounded; **REBUILD** valuable behavior behind undesirable coupling; **MOVE** valid behavior owned elsewhere; **REMOVE** no required consumer; **INVESTIGATE** insufficient evidence. A MOVE is complete only when the receiving owner verifies the behavior; FX's obligation is to hand over the behavior description and fixtures listed here.

Test status legend: **P** observed passing locally at `255c6cf`; **F** observed failing (environment-specific, see [BASELINE.md](BASELINE.md)); **CI** covered by an existing deterministic suite not run locally (E2E/WASM lanes); **L** requires live credentials; **—** no test.

## 1. Summary

| ID | Capability | Value to consumers | Current owner → target | Disposition | Replacement / receiving owner | Acceptance evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `INF-CONTRACT` | Provider-neutral request, message, part, completion and finish vocabulary | Lets any caller describe one inference and read its result | FX (spread over `types.zig`, `message.zig`, `stream_provider.zig`) → FX | REBUILD | `fx_core` contract (`rust/fx-core`, implemented in R1; ARCHITECTURE §4 A) | R1 test map, BEHAVIOR_MATRIX §8 (`cargo test --locked`) |
| `INF-SEAM` | The provider seam `stream_provider.Provider` | Decouples the agent loop from transport | FX → FX | REBUILD | `fx_core::Capability` (R2); old type deleted in R3 | No remaining reference to `stream_provider` (`rg`) |
| `INF-WIRE` | Request encoding to AI SDK v3 and history validation | Valid provider requests | FX → split | REBUILD | Validation in the Rust executor (R2); encoding in Easy-LLM | BM-07, BM-17; Easy-LLM smoke |
| `INF-STREAM` | Incremental stream decoding and normalization (text, reasoning, tool input, tool calls, provider results, finish) | Live output and authoritative proposals | FX → split | REBUILD | Normalizer in the Rust executor (R2); SSE decoding in Easy-LLM | BM-02, BM-04, BM-10, adversarial A-1..A-8 |
| `INF-EXEC` | One attempt: build, send, stream, classify; bounded execution with deadline | Single reliable inference call | FX (`gateway_step.zig`, `runBoundedHttpOperation`) → FX | REBUILD | the Rust executor (R2) | BM-01, BM-08, BM-11 |
| `INF-ERR` | Failure classification, delivery certainty, network evidence, diagnostics | Safe retry decisions by the caller | FX → FX | REBUILD | `fx_core::Failure`, `ErrorKind`, `DeliveryCertainty` | BM-06, BM-08 |
| `INF-TOOLS` | Tool definitions in requests; tool-call proposal identity, integrity, provenance and admission | Model can propose tool use without authority | FX → FX | KEEP (types) / REBUILD (shape) | `ToolDefinition`, `ToolCallProposal`, `ProviderToolRecord`, `admitProposals` | BM-04, A-3..A-7 |
| `INF-CONTENT` | Image content parts in requests | Vision requests | FX/Chip (`images/`) → FX (part type), Chip (loading) | REBUILD | `Part.image` | BM-03 |
| `INF-OPTIONS` | Generation options: max output tokens, reasoning effort, fast mode, structured output | Caller control over generation | FX + catalog heuristics → FX (fields) / Easy-LLM (mapping and validation) | REBUILD | `GenerationOptions` | BM-03; Easy-LLM rejects unsupported options as `invalid_request` |
| `INF-USAGE` | Token usage, cost, generation identity | Accounting by the consumer | FX + Vercel `/v1/generation` → FX (per-call facts) / Easy-LLM (reconciliation) | REBUILD / MOVE | `Finish.usage`, `Finish.cost`, `metadata.generation_id` | BM-05 |
| `INF-BIND` | Composition of the concrete provider (native Gateway, host fetch bridge) | Choosing what executes inference | FX → FX (interface) / Easy-LLM (implementation) | REBUILD | Caller passes a `Capability`; no compile-time provider choice | BM-13 |
| `OBS-DIAG` | Opt-in tracing with keyless previews; request-shape summaries | Debuggability without leaking content | FX → FX | REBUILD | bounded redacted diagnostics in the Rust executor (R2) | BM-15 |
| `SHR-UTIL` | Shared helpers (`io.zig`, text, sort, memory) | Building blocks | FX → FX (subset) | KEEP | `src/core/shared` subset listed in audit 05 §2 | Rust core needs none of them; it uses `std` only plus the allowlisted serde crates |
| `SHR-SECRET` | Secret zeroing (`secret.zeroAndFree`) and keychain service naming | Credential hygiene | FX → FX (zeroing) / Easy-LLM (naming) | KEEP | unchanged | Unit tests |
| `PRV-GATEWAY` | Vercel AI Gateway HTTP client, endpoints, headers, URL gating | Reaching the one backend | FX → Easy-LLM | MOVE (Vercel constants REMOVE) | Easy-LLM transport | Easy-LLM smoke; `rust/fx-core/check-boundaries.sh` forbids HTTP clients and provider crates |
| `PRV-AUTH` | Credential sources, precedence, Sign in with Vercel, OAuth, keychain, teams | Authenticated access | FX → Easy-LLM | MOVE; Vercel login and teams REMOVE | Easy-LLM credentials | FX contains no credential type |
| `PRV-CATALOG` | Model catalog, capability heuristics, default model, picker curation | Model choice and limits | FX → Easy-LLM | MOVE | Easy-LLM registry | Chip obtains capabilities from Easy-LLM |
| `PRV-ACCOUNT` | Credits balance | Account visibility | FX → Easy-LLM or none | REMOVE from FX | Easy-LLM if it wants it | — |
| `AGT-LOOP` | Agent turn loop, worker queue, step limits, presentation of turns | The coding-agent product | FX → Chip | MOVE | Chip | Chip's own suite; fx shell keeps working through Chip |
| `AGT-RECOVERY` | Pure retry/continuation policy (`model_response_recovery.decide`) | Robust turns | FX → Chip | MOVE | Chip, fed by `fx_core::Failure` | Its 9 unit tests move with it |
| `AGT-TOOLS` | Tool specs, admission, dispatch, built-in tools, vision tool | Agent capabilities | FX → Chip | MOVE | Chip | Chip's suite |
| `AGT-PERM` | Permission modes, rules, approvals, model-based auto review | Safety of tool use | FX → Chip / Attn (OD-4) | MOVE | Chip / Attn | Their suites |
| `AGT-SESSION` | Durable sessions, usage ledgers, prompt history, artifacts | Resume and accounting | FX → Chip | MOVE | Chip | Migration plan R-7 |
| `AGT-SUBAGENT` | Child agent sessions | Delegation | FX → Chip | MOVE | Chip | — |
| `AGT-MCP` | MCP client and JSON Schema validator | External tools | FX → Chip | MOVE | Chip | `tests/json-schema` corpus moves with it |
| `AGT-SKILLS` | Skills discovery and invocation | Reusable instructions | FX → Chip | MOVE | Chip | — |
| `AGT-HOOKS` | Lifecycle hooks (`pre_tool_use`, `stop`, ...) | Extensibility | FX → Chip | MOVE | Chip | — |
| `AGT-MODES` | ACP modes (`code`, `ask`) | Mode switching | FX → Chip | MOVE | Chip | — |
| `AGT-CONTEXT` | System prompt, project instructions, workspace context, history budget | Prompt assembly | FX → Chip | MOVE | Chip | — |
| `AGT-WEB` | `web_fetch` and `web_search` tools (search is provider-executed) | Web access | FX → Chip (tool) / Easy-LLM (search backend) | MOVE | Chip | Provider-executed records still expressible (BM-04) |
| `EXE-PROC` | Command execution, process trees, background processes, shell analysis | Running commands | FX → Compute | MOVE | Compute | — |
| `EXE-TERM` | Hosted terminals, VT engine, terminal tool | Interactive processes | FX → Compute | MOVE | Compute | — |
| `EXE-SANDBOX` | macOS Seatbelt sandbox and widening heuristics | Containment | FX → Compute | MOVE | Compute | — |
| `EXE-REMOTE` | Remote command execution contract; Vercel Sandbox client | Remote exec | FX → Compute (contract); Vercel client REMOVE | MOVE / REMOVE | Compute | — |
| `EXE-WORKSPACE` | Browser host workspace exec contract | Commands in browser hosts | FX → Compute | MOVE | Compute | — |
| `EMB-NAPI` | Native Node addon: handles, threading, fetch bridge, error codes | Node embedding | FX → FX | REBUILD (ACP pipes REMOVE) | the N-API adapter (R4) | BM-12, BM-14 |
| `EMB-WASM` | WASM core module | Browser embedding | FX → FX | REBUILD | `wasm32-unknown-unknown` reactor (R4) | BM-14, BM-16 |
| `EMB-SDK` | npm `libfx` host layer, loader, backend selection | JS embedding | FX → FX (inference API) / Chip (`createFxAgent`) | REBUILD | new `libfx` major version | SDK lanes on the new API |
| `EMB-ACP` | ACP server and ACP-shaped SDK | Editor integration | FX → Chip | MOVE | Chip | `tests/e2e/acp.test.ts` moves |
| `EMB-TERM` | Browser terminal (`fx-term.wasm`, xterm adapter, demos) | Hosted TUI | FX → product shell | MOVE (Vercel demo REMOVE) | OD-1 | — |
| `EMB-HOST` | Host capability abstraction (`hosts/`) | Portability | FX → FX (narrowed) | REBUILD | `runtime_profile` pattern kept for adapters | — |
| `PRD-TUI` | Inline terminal UI, input, notifications, tapes | End-user product | FX → product shell | INVESTIGATE (OD-1) | Chip product or separate shell repo | — |
| `PRD-CLI` | CLI commands, slash commands, `fx ask` | End-user product | FX → product shell | INVESTIGATE (OD-1) | — | `fx ask --json` schema preserved by its owner |
| `PRD-APP` | App composition root (`main.zig`, `core/app`) | Wiring | FX → product shell | INVESTIGATE (OD-1) | — | — |
| `PRD-CONFIG` | Profile and project settings | User configuration | FX → product shell / Chip | INVESTIGATE (OD-1) | FX reads no config | — |
| `PRD-OUTPUT` | Text and JSON snapshot contracts | Scriptable CLI output | FX → product shell | INVESTIGATE (OD-1) | — | — |
| `PRD-UPGRADE` | Self-upgrade from `releases.fx.sh` | Distribution | FX → none | REMOVE (OD-1 may retain with a neutral base) | — | — |
| `PRD-FEEDBACK` | `fx.sh/feedback` URL | Feedback | FX → none | REMOVE | — | — |
| `OPS-BUILD` | `build.zig` graph | Building | FX → FX | REBUILD | core lib, napi, wasm, tests | Full CI |
| `OPS-CI` | PR CI, Full CI, public-surface audit | Quality gates | repo → repo | REBUILD | drop Gateway key blanking and live job | Full CI on four runners |
| `OPS-RELEASE` | Release, dev release, CDN, npm publish, changelog drafting | Distribution | repo → repo | REBUILD (Vercel Blob, deploy hook, AI-Gateway drafting REMOVE) | GitHub Releases + npm | — |
| `OPS-SIZE` | Binary size reporting | Footprint control | repo → repo | KEEP | retarget at `libfx.node` and `fx-core.wasm` | — |
| `OPS-BENCH` | Startup and UI benchmarks | Latency budgets | FX → product shell | INVESTIGATE (OD-1) | new executor micro-benchmark in FX | — |
| `OPS-PGSO` | Profile-guided macOS arm64 release qualification | Binary performance | FX → product shell | INVESTIGATE (OD-1) | — | — |
| `OPS-TEST-E2E` | Bun/tmux E2E suite | Behavior regression | FX → per file | INVESTIGATE per file | classified in BEHAVIOR_MATRIX §4 | — |
| `OPS-EVALS` | Live LLM evals via `fx ask --json` | Agent quality | FX → Chip | MOVE | Chip, against Easy-LLM | L |
| `OPS-REPO` | Issue template, `.gitignore` | Repository hygiene | repo | KEEP | — | — |
| `DOC` | README, CONTRIBUTING, AGENTS, CHANGELOG, LICENSE, notices | Documentation and legal | repo | REBUILD / KEEP | LICENSE copyright line must be preserved (Apache-2.0 §4) | — |

## 2. Detailed entries for capabilities FX keeps or rebuilds

### INF-CONTRACT

- **Current implementation:** `src/core/shared/types.zig` (`ChatRole` :560, `ChatMessage` :862, `ChatCachePolicy` :857, `ImageAttachment` :841, `Usage` :875, `ProviderFinishReason` :915, `GatewayCompletion` :951, `ToolChoice` :1546, `ReasoningEffort` :1561, `classifyProviderCompletion` :1139); `src/core/shared/message.zig` (`Message`, `Request{messages, tool_choice}` :124); `stream_provider.zig` (`BuildRequest`, `Request`, `Result`, `StructuredResponseFormat`).
- **Entry point:** internal only (`Provider.build/stream`); no public API.
- **Call graph:** orchestrator → `gateway_step.streamGatewayCompletion` → `Provider.stream` → `builtins/gateway.streamAgentCompletion` → `gateway_client` → completion back.
- **Contracts today:** see [audit/01](audit/01-inference-path.md) §1-3; wire evidence in [evidence/observed-wire.md](evidence/observed-wire.md).
- **State and lifecycle:** request built per attempt; result ownership `borrowed|owned` with manual `deinit`.
- **Failure and cancellation:** `anyerror` plus HTTP status plus out-parameter evidence.
- **Tests:** `stream_provider.zig` 1 (P), `types.zig` (P), `gateway_json.zig` 35 (P).
- **Proposed owner:** FX. **Disposition:** REBUILD.
- **Replacement:** ARCHITECTURE §4 A. Changes: typed parts instead of `ChatMessage` strings plus side arrays; `ToolChoice` gains `required` and `named`; `ReasoningEffort` becomes opaque `named`; billing becomes opaque `cost`; HTTP status becomes a diagnostic hint.
- **Acceptance:** every behavior in BM-01..BM-05 expressed with the new types; JSON encoding round-trips every variant; no field refers to a provider, endpoint or credential.
- **Status (R1):** implemented in `rust/fx-core/src/contract.rs`, `validate.rs` and `wire.rs`; covered by the tests and fixtures listed in BEHAVIOR_MATRIX §8. Gaps that need the executor are listed in §8.3.

### INF-STREAM

- **Current implementation:** `src/gateway/client.zig` `consumeSseStreamTraced` (:2751-3264), `SseEventReader` (:2619-2679), `SseToolCallAccumulator` (:1928-1947), `captureGenerationMetadata` (:2681), `parseSseUsage` (:2467), `parseSseBilling` (:2488); `src/core/agent/runtime/assistant_stream.zig` callbacks (:178-272).
- **Observable behavior:** in-order synchronous callbacks for content, reasoning, tool start, tool input; authoritative tool calls; finish returns immediately; partial results on EOF without finish; strict finish vocabulary; tool-call identity reconciliation; provider result correlation.
- **Consumers:** agent loop, vision tool, web-search worker, permission reviewer, N-API and WASM via `host_stream_provider`.
- **Tests:** 120 in `client.zig` (P); E2E `gateway-stream-lifecycle.test.ts` (CI), `tui-gateway-stream-lifecycle.test.ts` (CI).
- **Disposition:** REBUILD. The normalization rules (I1-I9 in ARCHITECTURE §4) move into the Rust executor's normalizer (R2) and run on typed events from any capability. The AI SDK v3 SSE decoding (event JSON shapes, `providerMetadata.gateway.*`) moves to Easy-LLM's Gateway adapter.
- **Acceptance:** each of the 120 `client.zig` stream tests is either ported to a normalizer test on typed events or explicitly assigned to Easy-LLM's adapter suite in BEHAVIOR_MATRIX §3; none is dropped silently.

### INF-EXEC

- **Current implementation:** `gateway_step.streamGatewayCompletion` (`gateway_step.zig:27-150`); `runBoundedHttpOperation` (`client.zig:1583-1678`); connection-setup policy and cancel watcher (`client.zig:707-879,1690-1734`).
- **Observable behavior:** one call per attempt; usage observation begin/complete/fail; deep copy of owned results; bounded variants with absolute deadlines; prompt socket shutdown on cancel; suspend detection.
- **Tests:** `gateway_step.zig` 4, `client.zig` bounded/cancellation tests (about 40), `gateway_flow.zig` 139 (P).
- **Disposition:** REBUILD as the Rust executor (R2). Usage observation moves to Chip. Socket-level cancel watching and suspend detection move to the capability (Easy-LLM transport), because FX no longer owns sockets; the executor keeps deadline enforcement and cancel propagation.
- **Acceptance:** BM-08 cancellation matrix and BM-11 concurrency pass against the deterministic fake capability.

### INF-ERR

- **Current implementation:** `DeliveryCertainty`, `NetworkFailureEvidence`, `AttemptEvidence` (`stream_provider.zig:20-63`); `isRetryableGatewayError`, `networkFailureEvidence` (`client.zig:10-47`); `gateway_failure_diagnostics.zig`; `gateway_error_format.zig`.
- **Disposition:** REBUILD into `Failure{kind, delivery, retry_after_ms, status_hint, detail}`, mapping table in ARCHITECTURE §8.
- **Acceptance:** BM-06: every row of the mapping table has a test driving the fake capability to that failure and asserting kind and delivery.

### INF-TOOLS

- **Current implementation:** `ToolCall`, `ToolArgumentIntegrity`, `FinalToolIdentity`, `ToolExecutionProvenance`, `ProviderResultIdentityFailure`, `authoritativeToolAdmission` (`types.zig:567-621,1256-1290`); tool schema encoding (`gateway_schema.zig`).
- **Disposition:** KEEP the semantics, REBUILD the shape (proposal vs provider record split).
- **Acceptance:** A-3..A-7 adversarial tests; `admitProposals` reproduces the four hard rejections the orchestrator relies on (`orchestrator.zig:4093`).

### INF-BIND

- **Current implementation:** `builtins/gateway.zig:126-140`; `gateway_provider.zig:89-98`; `host_stream_provider.zig`; `js_host_stream_provider.zig`; comptime choice `main.zig:430-435`.
- **Disposition:** REBUILD. FX defines `Capability`; Easy-LLM implements it; callers pass it explicitly. The eight-service bundle is dissolved: `agent_stream` becomes the capability, the other seven move to Easy-LLM or Chip.
- **Acceptance:** BM-13: FX builds and passes its suite with no Easy-LLM code present (fake capability only); an optional smoke test runs the same suite against Easy-LLM.

### OBS-DIAG

- **Current implementation:** `debug_trace.zig` (opt-in scopes, 2 MiB rotation, keyless previews); `formatGatewayRequestShapeSummary` (`gateway_json.zig:635`); network ring (`workspace/network_metrics.zig`).
- **Disposition:** REBUILD as `Diagnostics` plus a trace hook. Persistence (`/trace` reports, rings) stays with the consumer.
- **Acceptance:** BM-15: a test feeds requests containing secret-shaped strings and asserts that neither diagnostics nor trace output contains message text, arguments or secrets.

### EMB-NAPI and EMB-WASM

- **Current implementation:** [audit/04](audit/04-embedding-build-ci.md) §3-4.
- **Retained mechanisms:** type-tagged handles, slot cap, idempotent destroy, `LIBFX_*` codes, pure fetch-state machine (`napi_fetch_state.zig`), guest-allocates/host-copies memory rule, negative-length overflow retry.
- **Removed:** ACP byte pipes, native HTTP inside N-API, WASI command entry, session/config/history/workspace/OAuth/terminal imports.
- **Acceptance:** BM-12, BM-14, BM-16 on both adapters with the same fixtures as the native executor.
