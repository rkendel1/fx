# Dependency report, Vercel trace and removal ledger

## 1. Direct and transitive dependencies

| Layer | Dependencies | Vercel-specific? |
| --- | --- | --- |
| Zig build (`build.zig.zon`) | none (Zig standard library only) | no |
| npm `libfx` runtime | none | no |
| npm dev and test | `@xterm/headless@6.0.0`; `@types/bun`, `typescript`; `@modelcontextprotocol/conformance@0.2.0-alpha.10` (transitive tree in `tests/e2e/conformance/package-lock.json`) | no (lockfiles contain no `ai`, `@ai-sdk/*` or `vercel` entries) |
| Python tooling | standard library | no |
| GitHub Actions | `actions/checkout@v4`, `mlugg/setup-zig@v2`, `softprops/action-gh-release`, setup actions for Node, Bun, LLVM, Hyperfine | no |
| Network services | Vercel AI Gateway, Vercel OAuth, Vercel REST API, Vercel Sandbox, Vercel Blob, `releases.fx.sh`, `fx.sh` | **yes** |

**There is no Vercel AI SDK package anywhere.** Every Vercel coupling is a protocol, endpoint, identity, naming convention, hosting service or document string, implemented in this repository's own Zig, JavaScript, YAML or Markdown. "Removing the SDK" is therefore not a step; removing the behaviors below is.

## 2. Trace from entry points to Vercel-specific code

```text
fx / fx ask / fx acp / libfx.node / fx-core.wasm
 └─ agent loop (orchestrator.zig:2511)
     ├─ gateway_step.streamGatewayCompletion (gateway_step.zig:27)
     │   └─ stream_provider.Provider ──┬─ builtins/gateway.zig:126 (native)
     │                                 │    ├─ gateway_json: AI SDK v3 prompt encoding, providerOptions.gateway/anthropic/xai
     │                                 │    └─ gateway/client.zig: https://ai-gateway.vercel.sh/v3/ai/language-model,
     │                                 │       ai-gateway-* and ai-language-model-* headers, x-vercel-ai-gateway-team,
     │                                 │       HTTP-Referer github.com/vercel-labs/fx, providerMetadata.gateway.*
     │                                 └─ host_stream_provider.zig (N-API, WASM): same headers and decoder via host fetch
     ├─ session_usage → generation_usage.zig → GET /v1/generation?id= (canonical origin only)
     ├─ web search tool → builtins/gateway.zig:692 → gateway.perplexity_search / gateway.parallel_search
     ├─ auto permission review → permission_reviewer.zig → Gateway chat, model zai/glm-5.2
     └─ vision tool → image_provider.zig → Gateway chat, model google/gemini-2.5-flash
 ├─ credentials (credentials.zig) ← VERCEL_OIDC_TOKEN, AI_GATEWAY_API_KEY, Sign in with Vercel, Keychain FX_AI_GATEWAY_API_KEY
 │   └─ login_flow.zig, oauth_session.zig → https://vercel.com (issuer, client id), https://api.vercel.com/v2/teams
 ├─ model catalog (builtins/gateway.zig:2063) → GET /coding-agent/v1/models (?teamId=)
 ├─ credits → GET /coding-agent/v1/credits
 ├─ devbox (builtins/devbox.zig) → POST https://api.vercel.com/v1/sandboxes/cmd  [reachable only from tests]
 └─ upgrade (upgrade_helpers.zig:21) → https://releases.fx.sh  [Vercel Blob behind it]
CI: release.yml, dev-release.yml, cdn-backfill.yml → blob.vercel-storage.com; prepare-release.yml → AI Gateway; ci.yml live ACP job → AI_GATEWAY_API_KEY
```

## 3. Findings classified

Categories from the brief: **1** required behavior to reimplement; **2** useful behavior through a smaller native primitive; **3** Easy-LLM responsibility; **4** Chip responsibility; **5** Compute responsibility; **6** unnecessary baggage.

| # | Finding | Evidence | Cat. | Behavior preserved where |
| --- | --- | --- | --- | --- |
| V-01 | AI SDK `LanguageModelV3` request semantics (roles, part kinds, tools, toolChoice, responseFormat, maxOutputTokens) | `gateway_json.zig:292-633`; observed wire | 1 | `fx_core::Request` |
| V-02 | AI SDK v3 stream semantics (text, reasoning, tool-input, tool-call, tool-result, finish, usage) | `client.zig:2751-3264` | 1 | `fx_core::Event` + normalizer |
| V-03 | v3 JSON/SSE encoding, `ai-language-model-*` and `ai-gateway-protocol-version` headers | `client.zig:620-635,1459-1494`; `host_stream_provider.zig:59-79` | 3 | Easy-LLM Gateway adapter (if Easy-LLM keeps Gateway as a backend) |
| V-04 | Canonical endpoint `ai-gateway.vercel.sh` and `/v3/ai/language-model` | `builtins/gateway.zig:41`; `client.zig:192` | 3 | Easy-LLM |
| V-05 | Loopback-only override gating that protects the bearer token | `client.zig:590-599,1769-1795`; `gateway.zig:752-758`; `napi_core_main.zig:637-646`; `sdk/node.js:113-126` | 2 | generalized "trusted endpoint" rule inside Easy-LLM; FX handles no bearer |
| V-06 | `x-vercel-ai-gateway-team`, `?teamId=`, team validation | `client.zig:193`; `gateway.zig:2093-2108`; `types.zig:1114` | 3 / 6 | Easy-LLM tenancy if needed |
| V-07 | Attribution `HTTP-Referer: github.com/vercel-labs/fx`, `X-Title: fx` | `client.zig:629-630` | 6 | removed |
| V-08 | `x-session-id` / `x-session-affinity` | `client.zig:1518` test | 2 | `Correlation.affinity_key`, mapped by Easy-LLM |
| V-09 | `providerMetadata.gateway.{generationId,cost,routing.canonicalSlug}`, `gen_` id format, strict timestamp | `client.zig:2488-2580,2681`; `types.zig:966,1067` | 3 | Easy-LLM maps to opaque `generation_id`, `cost` |
| V-10 | `/v1/generation?id=` deferred billing reconciliation, trusted origin | `client.zig:253-344,605`; `generation_usage.zig` | 3 | Easy-LLM |
| V-11 | `providerOptions.gateway.speed = "fast"`, `providerOptions.anthropic.cacheControl`, `providerOptions.xai.parallelToolCalls` | `gateway_json.zig:431-443,510-516` | 3 | `GenerationOptions.speed`, `CacheHint`; mapping in Easy-LLM |
| V-12 | `provider/model` slug convention, prefix heuristics, hard-coded context windows | `model_capabilities.zig:84-184` | 3 | Easy-LLM registry; `ModelRef` opaque |
| V-13 | Default model `zai/glm-5.2`; reviewer model `zai/glm-5.2`; vision model `google/gemini-2.5-flash` | `builtins/gateway.zig:40`; `auto_classifier.zig:15`; `image_provider.zig:13` | 3 / 4 | Easy-LLM default; Chip chooses models for its tools |
| V-14 | GLM-only body user-agent injection | `builtins/gateway.zig:258-273` | 6 | removed (Easy-LLM may need its own quirks) |
| V-15 | Model catalog `/coding-agent/v1/models`, anonymous fallback, picker curation | `gateway.zig:42,2063-2447`; `model_catalog.zig` | 3 | Easy-LLM |
| V-16 | Credits `/coding-agent/v1/credits`, `fx credits`, `/credits` | `gateway.zig:43,489-532` | 3 / 6 | Easy-LLM if wanted |
| V-17 | API key validation against `/coding-agent/v1/models` | `gateway.zig:645-671` | 3 | Easy-LLM |
| V-18 | Credential sources `VERCEL_OIDC_TOKEN`, `AI_GATEWAY_API_KEY`, precedence | `credentials.zig:218-297`; `auth_runtime.zig:21-26`; `types.zig:90-95` | 3 | Easy-LLM |
| V-19 | Sign in with Vercel: issuer, client id, scope, teams API, branded copy | `oauth_session.zig:13-15`; `login_flow.zig:19,550-615,982-1063` | 6 | removed |
| V-20 | Generic OAuth device flow (RFC 8414/8628/7009) | `oauth.zig:96-224` | 2 / 3 | Easy-LLM (or a shared library also used by MCP OAuth in Chip) |
| V-21 | Keychain service `FX_AI_GATEWAY_API_KEY`, `~/.fx/api-key`, OAuth session storage | `native_keychain.zig:7-9`; `profile_paths.zig:6-7` | 2 / 3 | generic `SecretStore` port kept; naming and semantics to Easy-LLM |
| V-22 | Branded errors "Fx needs access to Vercel AI Gateway..." | `credentials.zig:163-165`; `output_contracts.zig:662-665,1853`; `cli_surface.zig:736,780,1491` | 6 | replaced by `ErrorKind.unauthenticated` and Easy-LLM's own text |
| V-23 | Web search through Gateway provider tools | `gateway.zig:53-54,673-1094` | 3 / 4 | Chip tool; Easy-LLM backend; `ProviderToolRecord` in FX |
| V-24 | Permission reviewer as a Gateway chat call | `permission_reviewer.zig:39-55,214` | 4 | Chip calls the Rust executor with structured output |
| V-25 | Vercel Sandbox devbox (`api.vercel.com/v1/sandboxes/cmd`, `VERCEL_TOKEN`), retired `vercel`/`just_bash` backends | `devbox.zig`; `sandbox.zig:53,99,525,575,921-976`; `types.zig:1518` | 5 / 6 | generic remote-exec contract to Compute; Vercel client removed |
| V-26 | Self-upgrade from `releases.fx.sh` (Vercel Blob) | `upgrade_helpers.zig:21`; `auto_upgrade.zig`; `upgrade_runtime.zig` | 2 / 6 | OD-1 decides; if kept, neutral base URL |
| V-27 | `fx.sh/feedback`, `fx.sh/setup.sh`, `fx.sh/docs`, `fx.sh/try` | `feedback/runtime.zig:3`; `README.md`; `sdk/README.md` | 6 | removed or rehosted by the shell owner |
| V-28 | Release CDN uploads to `blob.vercel-storage.com`, deploy hook | `release.yml:141-172`; `dev-release.yml:107-208`; `cdn-backfill.yml` | 6 | GitHub Releases + npm |
| V-29 | Changelog drafted through AI Gateway | `prepare-release.yml:70,133-140` | 6 | human draft or Easy-LLM |
| V-30 | Live ACP CI job using `AI_GATEWAY_API_KEY`; credential blanking in CI | `ci.yml:228-279,375`; `full-ci.yml:36-37,111-112`; `pgso-macos-arm64.yml:29-30`; `scripts/pgso/corpus.py:38-39` | 6 | removed; deterministic fakes only |
| V-31 | `vercel.json` for the hosted terminal demo | `sdk/scripts/package-term-demo.mjs:44-82` | 6 | removed |
| V-32 | SDK docs requiring a Vercel AI Gateway credential; `index.html` storing `FX_API_KEY` in `localStorage` | `sdk/README.md:18,54,151,229,295-297`; `sdk/NAPI.md:134-143`; `sdk/index.html:288` | 6 | rewritten |
| V-33 | Evals require `AI_GATEWAY_API_KEY`/`VERCEL_OIDC_TOKEN` and the Gateway URL | `tests/evals/eval-helpers.ts:1,531`; `agent-quality-ab.ts:219,288-289` | 4 | Chip evals against Easy-LLM |
| V-34 | E2E emulation of vercel.com issuer, `use:ai-gateway` scope, teams | `tests/e2e/auth-refresh.test.ts:30-166` | 6 | removed |
| V-35 | Test fixtures referencing `vercel-labs/agent-skills`, `vercel-labs/fx`, Gateway origins in usage tests | `builtins/skills.zig:1672-1941`; `github_publish.zig:250-277`; `session_usage.zig:2951-4731` | 6 / 4 | move with their owners; FX core fixtures use neutral names |
| V-36 | `scripts/check-public-surface.sh` checks for `vercel-internal-*` slugs and Vercel-shaped team ids | `check-public-surface.sh:16-28` | 2 | keep (leak protection stays useful) |
| V-37 | `AGENTS.md` claims benchmark results upload to Vercel Blob; `bench.yml` has no upload step | `AGENTS.md` "Benchmarks"; `bench.yml` | 6 | doc drift, fixed in R6 |
| V-38 | LICENSE copyright "Vercel, Inc." | `LICENSE:179` | 1 (legal) | **must be preserved** in any derivative under Apache-2.0 §4; not removable |
| V-39 | Canonical repository references `vercel-labs/fx` in docs, headers, package metadata | `AGENTS.md`; `sdk/package.json`; `client.zig:629` | 6 / OD-6 | depends on where the rebuilt FX is published (OD-6) |

Tests and fixtures that validate Vercel behavior rather than an FX contract: V-30, V-33, V-34, the billing and team tests in `client.zig` and `builtins/gateway.zig`, `auth_runtime.zig`/`login_flow.zig`/`oauth_session.zig` unit tests, `sdk/tests/test-term-login.mjs`, `sdk/tests/test-core-live.mjs`. None of them is ported to FX; they move with their behavior or are removed with it.

## 4. Removal ledger

Every proposed deletion, with its justification and consumer-impact analysis. "Consumers" means callers found by symbol search across `src/`, `sdk/`, `tests/`, `scripts/`, `.github/` and build files (see `external_ref_files` in [inventory/symbols.tsv](inventory/symbols.tsv)), plus external users of the public surface.

| Item | Location | Justification | Known consumers | Impact and mitigation | Step |
| --- | --- | --- | --- | --- | --- |
| `stream_provider.Provider`, `BuildFn`, `StreamFn`, `Request`, `Result`, `BuildRequest` | `src/core/agent/stream_provider.zig` | superseded by `fx_core::Capability` (R2) | `gateway_step.zig`, `orchestrator.zig`, `image_provider.zig`, `deps.zig`, `app_agent_runtime.zig`, `app_callbacks.zig`, `acp/prompt.zig`, `subagent/agent_adapter.zig`, `builtins/gateway.zig`, `permission_reviewer.zig`, `host_stream_provider.zig`, tests | all migrated in the same PR; no external consumer (type is internal) | R5 |
| `ProviderAttemptOwner` (both copies) | `stream_provider.zig:43`, `client.zig` | FX never retries | `gateway_step.zig`, `client.zig`, `orchestrator.zig` | retry ownership becomes Chip's by construction | R5 |
| Duplicate `BuildBudget`, `StructuredResponseFormat` | `gateway_json.zig` | duplicates | `gateway_json.zig`, `builtins/gateway.zig` | none | R5 |
| `postGatewayCompletion`, `parseGatewayCompletion`, `freeGatewayCompletion` | `client.zig:610-676`; `gateway_json.zig:762-857` | dead OpenAI-shaped path | tests only | delete with their tests | R5 |
| `fetchModelIds*`, `fetchPickerModel*` public functions | `builtins/gateway.zig:1949-1995` | test-only public API | tests only | delete or make test-local | R5 |
| Gateway HTTP client, SSE framing, headers, endpoints | `src/gateway/client.zig` (non-normalizer parts), `generation_usage.zig`, `js_host_model_catalog.zig` | provider transport belongs to Easy-LLM | `builtins/gateway.zig`, `host_stream_provider.zig`, N-API, WASM | handed to Easy-LLM with their 80-odd tests (BEHAVIOR_MATRIX §4); FX keeps the normalizer | R5 |
| `src/core/gateway/*` except validation and shape summary | catalog, provider bundle, metadata | Easy-LLM | app, CLI, ACP, UI model menu | shell obtains catalog from Easy-LLM | R5 |
| `src/core/auth/*` (except `secret.zig`) | auth runtime, credentials, OAuth, login | Easy-LLM | app, CLI (`login`, `logout`, `setup`, `teams`), UI auth hub, WASM OAuth imports | shell commands delegate to Easy-LLM or are dropped (OD-1); Vercel login removed outright | R5 |
| Vercel login, teams, credits, branded copy | `login_flow.zig`, `oauth_session.zig` constants, `credentials.zig` messages, `gateway.zig` credits | Vercel-only | `fx login/logout/teams/credits`, `/credits`, auth hub, `auth-refresh.test.ts`, `tui-auth-source-selection.test.ts`, `test-term-login.mjs`, PGSO corpus entries | **breaking for shell users**; documented in the release; PGSO corpus entries removed in the same PR | R5 |
| Devbox Vercel client, `BackendKind.vercel`/`just_bash` | `builtins/devbox.zig`; `types.zig:1518`; `sandbox.zig` branches | retired, unreachable outside tests | tests only | none | R5 |
| Self-upgrade, feedback URL | `src/core/upgrade/*`, `src/core/feedback/*` | Vercel-hosted distribution | `fx upgrade`, auto-upgrade, `/feedback` | decided with OD-1; if the shell keeps self-update it takes a neutral base | R5 |
| ACP byte pipes in N-API; ACP server inside `fx-core.wasm` | `napi_core_main.zig`; `wasm_core_main.zig` | embedding surfaces become inference APIs | npm `libfx` users of `createFxAgent` | **breaking npm major version**; `createFxAgent` moves to Chip's package; migration note | R4 |
| `fx-term.wasm`, xterm adapter, term demo, `vercel.json` | `wasm_term_main.zig`, `sdk/fx-sdk.js` terminal parts, `sdk/scripts/package-term-demo.mjs` | product UI, not core | `createFxTerminal` users, `fx.sh/try` | moves with the shell (OD-1); Vercel demo hosting removed | R4 |
| Blob/CDN/deploy-hook workflow steps, `cdn-backfill.yml`, AI-Gateway changelog drafting | `.github/workflows/*` | Vercel infrastructure | release process | GitHub Releases and npm remain; maintainers draft changelogs | R6 |
| Live-key CI job and key blanking | `ci.yml`, `full-ci.yml`, `pgso-macos-arm64.yml`, `scripts/pgso/corpus.py` | deterministic fakes replace them | CI | none | R6 |

Nothing is removed by R0 or R1. Every row above is scheduled in [ROADMAP.md](ROADMAP.md) and must ship together with its consumer migration. Legacy Zig code is deleted only in R5, after parity is demonstrated; until then it is the behavioral oracle.
