# Audit 05: Product shell (UI, sessions, app, CLI, shared primitives)

Scope: `src/ui/**`, `src/core/{session,app,cli,slash_commands,output,input,notifications,mods,shared,terminal,workspace,hooks}`, `src/builtins/{hooks/*,commands,context,modes,mcp,skills}.zig`. Line numbers refer to commit `255c6cf`. ✓ marks claims re-verified while writing.

## 1. Module table

| Module | Files | Lines | Tests | Responsibility | Touches the inference seam? | Target |
| --- | ---: | ---: | ---: | --- | --- | --- |
| `src/ui/**` | 85 | ~129,000 | 1,808 | inline TUI: render engine, transcript, footer and menus, input decoding, alternate-screen owners, subagent manager, WASM terminal | no; consumes model cache, capabilities, auth status for display | shell (OD-1) |
| `src/core/session` | 39 | 63,765 | 599 | durable sessions (event log v1, schema v3), usage accounting, prompt history, child stores, result store, web-fetch artifacts | projects history into request messages (`session.zig:5`); usage calls `generation_usage` | Chip; billing lookup Easy-LLM |
| `src/core/app` | 35 | 65,405 | 874 | composition root of the interactive app | **yes**: injects the provider bundle (`app_agent_runtime.zig:207-224`, `app_callbacks.zig:266-272`) | shell |
| `src/core/cli` | 6 | 16,416 | 205 | dispatch of 22 commands; `fx ask` (`cli_ask.zig`, 9,296 lines); replay; doctor | **yes**: `cli_ask.zig:943,1790` | shell |
| `src/core/slash_commands` | 2 | 3,046 | 81 | command specs and router | no | shell |
| `src/core/output` | 7 | 7,461 | 107 | 15 snapshot types with text and JSON renderers | no | shell; Models/Credits/Usage snapshots Easy-LLM |
| `src/core/input` | 27 | 8,755 | 111 | composer editing | no | shell |
| `src/core/notifications` | 2 (+ sounds) | 553 | 10 | sound cues | no | shell |
| `src/core/mods` | 1 | 129 | 3 | generic registries | no | shell |
| `src/core/shared` | 17 | 18,092 (8,945 generated) | 180 | primitives | `types.zig`, `message.zig` are the seam vocabulary | partial FX |
| `src/core/terminal` | 16 | 36,538 | 279 | hosted terminals and VT engine | no | Compute |
| `src/core/workspace` | 20 | 16,079 | 255 | file index, grep, context, tapes, `/trace` rings | no | Chip / shell |
| `src/core/hooks`, `src/builtins/hooks` | 8 | 2,424 | 29 | lifecycle hooks | no | Chip |
| `src/builtins/context.zig` | 1 | 3,736 | 62 | system prompt text and project context | no (feeds messages) | Chip |

## 2. `src/core/shared` primitives worth keeping in FX

| File | Keep in FX | Declarations |
| --- | --- | --- |
| `types.zig` (2,826) | inference subset only | see `inventory/symbol_overrides.tsv` (ChatRole, ChatMessage, ToolCall family, Usage, ProviderFinishReason, GatewayCompletion → renamed, completion classification, ToolChoice, ReasoningEffort) |
| `message.zig` (236) | yes | `Role`, `Content`, `Message`, `Request{messages, tool_choice}` (:124): already a small request model, used by `gateway_step.zig:6` and `session.zig:5` |
| `io.zig` (1,298) | yes | `setIo`/`getIo`, `getenv`, timestamps, `sleep`, `readFileToEnd` |
| `debug_trace.zig` (690) | yes | opt-in scoped trace (`FX_TRACE*`), 2 MiB rotation, `keylessJsonPreview` / `redactedJsonPreview` |
| `text_utils.zig` (1,286) | partly | `maskSecrets` (:430) and `findSecretSpan` patterns, `redactUrlForDisplay`, `IncrementalUtf8Validator` (:164), UTF-8 boundary helpers |
| `token_estimate.zig` (46) | yes | `StreamingEstimator` (chunk-boundary independent) |
| `gateway_error_format.zig` (489) | rebuild | classification into the FX error taxonomy; wording to callers |
| `collections.zig`, `mem_utils.zig`, `sort_utils.zig` | optional | small helpers |
| `display_width.zig`, `unicode_display_data.zig`, `entity_spans.zig`, `list_window.zig`, `model_context_encoding.zig`, `profile_paths.zig`, `darwin_process_spawn.zig` | no | shell, Chip or Compute |

## 3. Session persistence (relevant to migration)

`~/.fx/sessions/<id>/` with `session.json` (schema v3, `storage_format: "event_log_v1"`), `events.jsonl` (envelopes `{log_generation, seq, event_id, timestamp_ms, event}`, 8 MiB frame cap), locks, `authority.json`, `control.json`, `checkpoint.json`, `usage-v2.json`, child stores and web-fetch artifacts. Legacy v1/v2 migration in `session_migration.zig`.

Provider coupling persisted in sessions:
1. Preferences `{model, effort, fast_mode}` with Gateway model slugs (`session_codec.zig:11-28`).
2. Usage snapshot with `pending: []PendingGeneration{id (gen_...), sequence, origin (https://ai-gateway.vercel.sh), team, observed_at_ms}` for deferred billing reconciliation (`session_usage.zig:226-290`).
3. History turns persist provider-derived tool-call identity (`ToolCall.provenance`, `provider_result`).

Credentials are **not** stored in sessions. FX core persists nothing; migration of these fields is Chip's and Easy-LLM's (risk R-7 in [../RISKS.md](../RISKS.md)).

## 4. Composition: where the provider is wired

- `main.zig:3195-3210` builds `app_entry_runtime.Config` with `.gateway_provider = builtin_gateway.provider`, `.default_model`, `.gateway_retry_count`, `.gateway_chat_url`.
- ✓ `main.zig:430-435` `agentStreamProvider()` picks `js_host_stream_provider.provider()` on WASM, else `builtin_gateway.agent_stream_provider`, at comptime.
- `app_agent_runtime.zig:207-224` builds `tool_runtime.Context` carrying the stream provider **together with** `api_key`, `gateway_team`, `credential_source`, `oauth_transport`, `model`, `gateway_retry_count`, `gateway_chat_url`, `fast_mode`, `effort`, `first_call_tool_choice`. Inference parameters and credentials travel inside the tool context.
- Headless: `cli_ask.zig:943,1790` (`agent_stream`), `:582` (`generation_usage`), `:585` (`web_search`), `:1912` (`model_catalog`). ACP: `acp_runner.zig:15-40`.
- `FX_BENCH`: `main.zig:2940-2948`, `app_entry_runtime.zig:173-197`.

## 5. Public output contracts

`fx ask --json` (`cli_ask.zig:3433-3518`):

```text
{ "output": string, "exit_code": int, "model": string, "session_id": string, "steps": int,
  "tool_calls": [ { "name", "status": "success"|"error", "command_result"?, "question"?, "web_search"?, "web_fetch"? } ],
  "error"?: string, "auth_failure"?: object,
  "recovery"?: { "state", "kind", "cause"?, "action"?, "required_action"?, "attempt", "attempt_limit", "delay_seconds", "durable", "message" } }
```

Error form (`renderErrorJsonResult`, :3520) observed: `{"output":"","exit_code":1,"model":"","session_id":"","steps":0,"tool_calls":[],"error":"MissingCredentials"}`. `tests/evals` depends on this schema. Inference-relevant fields: `output`, `model`, `error`, `recovery`; the rest is agent-loop state.

Snapshots in `output_contracts.zig` (each with `kind` and text/JSON renderers): `CommandFailureSnapshot`, `UsageSnapshot`, `WorkspaceSnapshot`, `StatusSnapshot`, `PermissionsSnapshot`, `ModelListSnapshot`, `SessionListSnapshot`, `SessionSummarySnapshot`, `SessionDetailSnapshot`, `SessionMigrationSnapshot`, `SessionRecoverySnapshot`, `DoctorSnapshot`, `BackgroundListSnapshot`, `BackgroundDetailSnapshot`, `CreditsSnapshot`, `UpgradeSnapshot`.

## 6. Diagnostics and redaction

- `debug_trace`: opt-in; gateway events log counts, not content (e.g. `client.zig:1420`); tool arguments logged through `keylessJsonPreview` (types and sizes only, depth 2, 6 fields).
- `maskSecrets` applied to model-facing tool results, MCP results, classifier context and `/trace`.
- `/trace` writes a Markdown report to `$TMPDIR` and copies it to the clipboard; it **includes prompts and transcript text** (only secret patterns are masked, `app_commands.zig:1811,1856`).
- `FX_RECORD` tapes contain raw terminal bytes, including prompts and output.
- In-memory `/trace` rings: `workspace/network_metrics.zig` (HTTP call ring), `tool_call_metrics.zig`.

FX core policy adopted from this: never log message bodies or credentials; log byte and token counts, ids and terminal causes only.

## 7. Inference-related logic hiding in the shell

Model catalog cache and menu (`model_cache_runtime.zig`, `ui/footer/model_menu_presentation.zig`, `ui/models_screen.zig`); credits (`/credits`, `fx credits`); effort and fast mode (validated against catalog capabilities, `session_commands.zig:1675-1800`; recovery kind `manual_retry_without_fast`); usage and billing accounting (`session_usage.zig` and friends); default model selection (`app_lifecycle.zig:1098-1131`); auth, login and teams; provider error formatting; prompt composition (`builtins/context.zig:106-122`, `session.zig:2438-2700`); web search; Gateway URL resolution. Each item is assigned in [../CAPABILITIES.md](../CAPABILITIES.md).
