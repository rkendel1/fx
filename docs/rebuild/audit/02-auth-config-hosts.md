# Audit 02: Authentication, configuration, hosts, upgrade

Scope: `src/core/auth/*`, `src/core/config/*`, `src/core/hosts/*`, `src/core/upgrade/*`, `src/core/feedback/*`, `src/core/github/*`, `src/builtins/devbox.zig`, `src/core/execution/devbox_executor.zig`, plus repository-wide search for Vercel coupling. Line numbers refer to commit `255c6cf`. ✓ marks claims re-verified while writing.

## 1. Credentials

`CredentialSource` (`src/core/shared/types.zig:90-95`) has exactly four values:

| Source | Loaded from | Evidence |
| --- | --- | --- |
| `vercel_oidc_token` | env `VERCEL_OIDC_TOKEN` | `credentials.zig:282,296,315-325` |
| `ai_gateway_api_key` | env `AI_GATEWAY_API_KEY` | `credentials.zig:283,297` |
| `fx_login` | Sign in with Vercel OAuth session, refreshed if expired | `credentials.zig:284,357-368` |
| `stored_key` | key saved by `fx setup`: macOS Keychain service `FX_AI_GATEWAY_API_KEY` or `~/.fx/api-key` (0600) | `credentials.zig:327-334`; `native_secret_store.zig:21-41,115,177`; `native_keychain.zig:7` |

Precedence (`credentials.resolvePreferring`, `credentials.zig:218-262`): an explicitly preferred source (profile setting `credential_source`) wins, even over environment variables; otherwise `VERCEL_OIDC_TOKEN` → `AI_GATEWAY_API_KEY` → `fx_login` → `stored_key`. The order is duplicated in `auth_runtime.zig:21-26`. `LoadMode.stored` never refreshes.

Other credential environment variables: `FX_DISABLE_KEYCHAIN`, `FX_OAUTH_CLIENT_ID`, `FX_E2E_OAUTH_ISSUER_URL` (loopback only), `FX_NO_OPEN_BROWSER`, `FX_SKIP_ONBOARDING`. Devbox reads `VERCEL_OIDC_TOKEN` then `VERCEL_TOKEN` itself (`builtins/devbox.zig:326-341`).

## 2. Sign in with Vercel

- Issuer ✓ `https://vercel.com`, default client id ✓ hard-coded (`oauth_session.zig:13-15`); a custom client id that gets `InvalidClient` falls back to the default (`login_flow.zig:476-480`).
- Scope `openid offline_access` (`oauth.zig:11`).
- RFC 8414 discovery with exact issuer match, RFC 8628 device authorization and polling, refresh, RFC 7009 revoke (`oauth.zig:103-224`). This part is a generic OAuth client.
- Teams ✓ `GET https://api.vercel.com/v2/teams` with the access token (`login_flow.zig:19,982-1063`); auto-select or picker; `fx teams` re-runs it (`:603-650`).
- Vercel-branded copy: "Signed in to Vercel.", "Selected Vercel team", "Fx needs access to Vercel AI Gateway..." (`login_flow.zig:550-551,615`; `credentials.zig:163-165`).
- Session storage: Keychain service `FX_OAUTH_SESSION_V1` on macOS (via an osascript/expect helper because `security -w` caps at 128 bytes), else `~/.fx/auth.json`; file-to-Keychain migration; `auth.lock` with a 2 s deadline; schema v1 (`oauth_session.zig:18-100,793-836`). On WASM, host imports `fx_oauth_session_{load,commit,remove}` with revision CAS (`js_host_auth.zig:26-46,156-180`).
- Refresh: expired 60 s early (`oauth_session.zig:20`); only `fx_login` is refreshable (`credentials.zig:477-479`).

## 3. Where credentials flow

`auth_runtime.Runtime.gatewayCredential()` returns `{api_key, gateway_team, source}` (`auth_runtime.zig:576-641`). It is sent to:

1. chat inference (`/v3/ai/language-model`, plus `x-vercel-ai-gateway-team`)
2. model catalog (`/coding-agent/v1/models`, team as `?teamId=` for logins, header otherwise; anonymous fallback)
3. credits (`/coding-agent/v1/credits`)
4. generation billing (`/v1/generation?id=`), canonical or loopback origin only
5. web search worker (Gateway provider-executed tools)
6. automatic permission reviewer (Gateway chat call, model `zai/glm-5.2`)
7. API key validation (`/coding-agent/v1/models`)
8. OAuth endpoints (vercel.com, api.vercel.com)

Gating: `FX_GATEWAY_BASE_URL`, `FX_GATEWAY_CHAT_URL`, `FX_E2E_GATEWAY_*` and the OAuth E2E issuer must be loopback HTTP with an explicit port and no userinfo (`client.zig:590-599,1769-1795`; `oauth_session.zig:536-570`). N-API requires the canonical URL or HTTP (`napi_core_main.zig:637-646`), mirrored in `sdk/node.js:113-126`. Team values must match `[A-Za-z0-9_-]{1,128}` (`types.zig:1114-1121`).

Hygiene finding: the bearer header is freed with `alloc.free` rather than zeroed ✓ on the native chat path (`client.zig:1178`) and the host path (`host_stream_provider.zig:60`); other paths zero it. The N-API API key is not zeroized (documented in `sdk/NAPI.md`).

## 4. Configuration

- Files: profile `~/.fx/settings.json`, project `<workspace>/.fx.json` (`config_runtime.zig:335,922`).
- Merge order (`loadMergedSettingsDetailedWithOptionalHome`, ~250-457): project, profile top level, profile `workspaces["<root>"]`; environment overrides applied later in `app_lifecycle.zig:1084-1102` (`FX_PERMISSION_MODE`, `FX_MAX_AGENT_STEPS`, `FX_MODEL`), duplicated in `doctor_runtime.zig:500-523`.
- Profile-only keys ignored in project config with diagnostic `ignored_project_user_only_setting` (`config_runtime.zig:542-585`).
- `Settings` (`config_runtime.zig:38-66`): `model, permission_mode, credential_source, yolo_acknowledged, max_agent_steps, max_tool_result_bytes, context_limits, first_call_tool_choice, context, fast_mode, input_appearance, maxxing_mode, slash_menu_categories, auto_upgrade, update_channel, startup_scrollback, prompt_history_enabled, effort, sandbox, statusline_*, notification_*, permission_rules`.
- Classification for the rebuild:

| Class | Keys / env |
| --- | --- |
| Inference request options (FX contract fields, values chosen by the caller) | `effort`, `fast_mode` (as `speed`), max output tokens |
| Provider selection, credentials, catalog (Easy-LLM) | `model` default, `credential_source`, `AI_GATEWAY_API_KEY`, `VERCEL_OIDC_TOKEN`, `FX_GATEWAY_*`, `FX_WEB_SEARCH_BACKEND`, `FX_OAUTH_CLIENT_ID`, `FX_DISABLE_KEYCHAIN` |
| Agent (Chip) | `permission_mode`, `permission`, `yolo_acknowledged`, `max_agent_steps`, `max_tool_result_bytes`, `context`, `context_limits`, `first_call_tool_choice`, `skill_match_fuzzy`, `additional_directories`, `prompt_history` |
| Execution (Compute) | `sandbox` |
| UI (product shell) | `input_appearance`, `maxxing_mode`, `slash_menu_categories`, `startup_scrollback`, `statusLine`, `notifications`, `FX_THEME`, `FX_SOUND`, `FX_SYNC_UPDATES`, `FX_RECORD*` |
| Distribution | `auto_upgrade`, `update_channel`, `FX_AUTO_UPGRADE` |
| Diagnostics (FX keeps an equivalent) | `FX_TRACE`, `FX_TRACE_LOG`, `FX_TRACE_STDERR`, `FX_TRACE_SCOPES`, `FX_BENCH` |

The rebuilt FX core reads **no** configuration file and no environment variable for inference behavior. Everything arrives in the typed request or the capability binding.

`model_capabilities.zig`: catalog metadata plus prefix heuristics (`anthropic/` → prompt caching, `xai/` → parallel tool calls, hard-coded context windows, :84-182); `resolveProviderOptions` maps effort and fast mode to provider options (:188-207). All of this is Easy-LLM.

## 5. Hosts layer

Vendor-neutral apart from names:

- `target.is_wasm` (comptime switch); `host.Capabilities{os_sandbox, background_processes, url_open, native_url_open, terminal}`; ports `UrlOpener`, `TerminalTitle`, `SecretStore`, `Clipboard` (`host.zig:17-203`).
- `native_keychain.zig`: drives `/usr/bin/security` and osascript; services `FX_AI_GATEWAY_API_KEY`, `FX_MCP_OAUTH_CREDENTIALS_V1`, `FX_OAUTH_SESSION_V1` (`:7-9`).
- `runtime_profile.zig`: comptime capability matrix; `native` enables auth, upgrade, web search, generation usage, MCP, subagents; `wasm` enables the `js_host_*` adapters and `cooperative_agent` (`:33-77`).
- `js_host_workspace.zig`: host exec contract (command ≤64 KiB, timeout 1–30,000 ms) — an execution-environment adapter.

## 6. Upgrade, feedback, telemetry

- CDN ✓ `https://releases.fx.sh` (`upgrade_helpers.zig:21`), backed by Vercel Blob; stable `latest.txt`, dev `dev.json`, tarball plus `.sha256` verified before replacing the binary (`upgrade_helpers.zig:197-263`). Background auto-upgrade unless `FX_AUTO_UPGRADE=0|false` or a `/zig-out/bin/` dev path (`main.zig:634-642`).
- Feedback: opens `https://fx.sh/feedback` (`feedback/runtime.zig:3`); no data is sent.
- Telemetry: none. `agent/runtime/telemetry.zig` is local turn accounting written to `debug_trace`.

## 7. Devbox

Vercel Sandbox ✓: `POST https://api.vercel.com/v1/sandboxes/cmd` with `{"command":"sh","args":["-lc",cmd],"cwd",...,"wait":true}` and a Vercel bearer (`builtins/devbox.zig:12-120,326-341`). The contract (`execution/devbox_executor.zig`) is generic apart from `VercelOutcome`. The public config marks `vercel` and `just-bash` retired ✓ (`sandbox.zig:53`), mapped to `auto`; no non-test caller of `BackendKind.parse` was found, so the Vercel backend is reachable only from tests.

## 8. Tests

- Auth: `auth_runtime.zig` 40, `credentials.zig` 16, `login_flow.zig` 21, `oauth.zig` 10, `oauth_session.zig` 21, `js_host_auth.zig` 1, `oauth_transport.zig` 1, `secret.zig` 1, `api_key_validator.zig` 1.
- Config: `config_runtime.zig` 70, `settings_store.zig` 57, `settings_catalog.zig` 8, `model_capabilities.zig` 6, `agent_steps.zig` 4, `context_limits.zig` 4, `js_host_config_store.zig` 0.
- Hosts: `host.zig` 8, `native_keychain.zig` 7 (skipped off macOS), `native_secret_store.zig` 4, `js_host_workspace.zig` 9, `runtime_profile.zig` 4, `url_opener.zig` 3, `wasm.zig` 2.
- Upgrade: 12 + 13 + 8 + 5.
- E2E: `auth-refresh.test.ts` (fake vercel.com issuer), `oauth-keychain-migration.test.ts`, `tui-auth-source-selection.test.ts`, `config-persistence.test.ts`, `cli.test.ts`, `mcp-auth.test.ts` (MCP OAuth, unrelated to Vercel).
- SDK: `test-term-login.mjs` (browser device login), `test-core-live.mjs` (live Gateway, opt-in, not in CI).
- Evals: all need `AI_GATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN` (`tests/evals/eval-helpers.ts:531`).
