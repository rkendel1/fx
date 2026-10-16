# Audit 03: Agent loop, tools, permissions, execution

Scope: `src/core/agent/**`, `src/core/tooling/*`, `src/tools/**`, `src/builtins/*.zig`, `src/core/{permissions,execution,shell_command,background,subagent,mcp,skills,hooks,modes,tasks,images,workspace,terminal}`. Line numbers refer to commit `255c6cf`. ✓ marks claims re-verified while writing.

Summary: about 300,000 lines in this scope. Under the target ownership it is almost entirely Chip (agent loop, tools, sessions, orchestration) or Compute (processes, PTYs, sandbox enforcement, terminal engine). The FX-relevant residue is the provider seam, the completion and tool-call types, stream accumulation, and the one-attempt wrapper.

## 1. The agent loop

Entry points: TUI `app_agent_runtime.zig:987`; ACP `acp/prompt.zig:602` (deps at :945-978); subagent child `subagent/execution.zig:961` (deps from `agent_adapter.zig:216-245`); facade `core/agent/agent_runtime.zig` (51 lines).

`orchestrator.processQueuedPrompt` (`orchestrator.zig:1668`) wraps `processQueuedPromptInner` (:1754-1960) in `TurnFinalizationGuard` (`finalization.zig:31`), which guarantees exactly one finish. The step loop `processQueuedPromptLoop` starts at ✓ `orchestrator.zig:2511` and runs to about line 7490: one function of roughly 5,000 lines mixing inference attempts and recovery, tool admission, permissions, parallel execution, presentation events, hooks, persistence, subagent authority and vision routing.

Dependencies: `AgentRuntimeDeps` (`runtime/deps.zig:186-248`) is a table of about 45 function pointers covering inference (`agent_stream_provider`, `cooperative_transport_pulse`, `available_model_capabilities`, `resolve_model_capabilities`, `refresh_gateway_credential`, `request_route_recovery`), tools, permissions, persistence, UI events, context injection and usage.

Per step (`orchestrator.zig:2636`, `while (agent_steps.allowsStep(limit, step))`):

1. cancel check (:2645) → `persistInterruptedTurnOnce`
2. auto-permission blocker check (:2651)
3. message assembly: stable prefix, ephemeral overlay (`.no_cache`), durable history, current user, within-turn suffix (`prompt_context.buildGatewayMessages`, `prompt_context.zig:27-45`)
4. attempt loop: vision projection; provider options from capabilities; tool choice (`.none` for `reconcile_tool`, else first-call setting or `.auto`, :2894-2899); `provider.build` (:2900); recovery checkpoint persisted before sending (:2945); `gateway_step.streamGatewayCompletion` (:2973); callbacks into `assistant_stream.zig` (:178-272)
5. completion admission: provider-executed tools materialized (:3890); usage reported (:4086); `types.authoritativeToolAdmission` (:4093) rejects duplicate ids, malformed ids, malformed provider results and malformed provider arguments as hard turn errors
6. terminal path (no tools): length-limited handling, Stop hook, `finishCommonAssistantTerminal` (:7594)
7. tool path: assistant tool-call step recorded; PreToolUse hook can rewrite or block (`lifecycle.zig:53`); `tool_preparation.prepareReadyCall`; permissions (`runtime/tool_admission.zig:538`); execution (`deps.execute_tool_call`); results appended; leading read-only calls run concurrently on threads (`parallel_execution.zig:35,140`); reactive sandbox widening (:870-988)
8. loop

Step limit: `FX_MAX_AGENT_STEPS`, default 0 = unbounded (`config/agent_steps.zig:3,23-25`).

Context management: **no model-driven summarization**. History is projected under a token budget (`available_input / 4`, default 24,000; `prompt_context.zig:13`, `config.zig:11-12`); `/compact` only moves `context_history_start` (`session.zig:1977-1980`); `HistoryTurn.compacted_summary` (`types.zig:1465`) is still restored and projected but has no live producer (INVESTIGATE, likely legacy); tool results capped at 64 KiB with spill to `read_tool_result` (`tool_result_limits.zig:7,14`).

Cancellation: one `*std.atomic.Value(bool)` set by ACP `session/cancel` (`acp/server.zig:1279`) or the TUI worker; cleanup in `finishPendingParallelCancelled` (:693), `finishPreparedCallsOnCancellation` (:749), `finishPendingCancelledCalls` (:822), `interruption.persistInterruptedTurnOnce`. Pause is separate (`recovery_pause_flag`).

Events: no bus; every UI or ACP update is a deps callback (`WorkerEvent`, `worker_runtime.zig:452-476`; ACP mapping `prompt.zig:945-978`).

## 2. Tools

- `tool_dispatch.Tool` (`tooling/tool_dispatch.zig:427-460`): model-facing name, description, schema, optional custom advertisement writer, `provider_executed`, 27 executor kinds, approval policy, labels, decode/validate/call callbacks, runtime provider kind, command adapters. Registry `mod_registry.ToolRegistry(Tool)` (:462). `DispatchContext` (:197-270) and `tool_runtime.Context` (`tool_runtime.zig:124`) are large god-contexts.
- Advertisement `tool_advertisement.zig` (order `builtins/tools.zig:1796`; read-only subset :1823); MCP dynamic tools selected at runtime via `mcp_select_tool` and passed as `selected_dynamic_tool_schemas`.
- Admission and permission engine `tooling/tool_admission.zig` (6,573 lines).
- Results `ToolExecutionResult` (`runtime/tool_contracts.zig:114-138`, 25 fields).

Built-in tools (specs `builtins/tools.zig:465-1300`):

| Tool | Side effects | Target owner |
| --- | --- | --- |
| `list_files`, `glob_files`, `grep_files`, `read_file`, `file_info`, `semantic_search` (local lexical walk, no embeddings) | filesystem read | Chip (tool), Compute (filesystem access) |
| `write_file`, `edit_file`, `delete_file`, `rename_file`, `copy_file`, `create_folder` | filesystem write | Chip / Compute |
| `memory` | writes `~/.fx/memories.json` | Chip |
| `open_file` | spawns `open`/`xdg-open` | Chip / Compute |
| `web_fetch` | HTTP | Chip |
| `web_search` (advertised as `perplexity_search`) | provider-executed by the Gateway | Chip (tool), Easy-LLM (backend) |
| `terminal` | process, PTY, tmux | Compute |
| `skill`, `install_skill` (`npx skills add ...`) | filesystem, process | Chip |
| `subagent` | child agent sessions with their own inference | Chip |
| `mcp_search_tools`, `mcp_select_tool`, `mcp_features` | MCP stdio processes and HTTP | Chip |
| `ask_user_question` | UI; also the permission-escalation bridge | Chip / Attn |
| `vision` | **secondary inference call** (`image_provider.zig:53`) | Chip (tool) consuming FX |
| `read_tool_result` | session spill store | Chip |

## 3. Permissions

- `PermissionMode{ask, auto, yolo}` (`types.zig:1503`). yolo short-circuits before rule evaluation and uses an effective sandbox of `none`.
- auto: configured rules → session grants → deterministic safe-tool authority → **model reviewer** (`permissions/auto_classifier.zig`, tool `permission_decision` :12, reviewer model ✓ `zai/glm-5.2` :15, 16 KiB packet :14; transport `builtins/gateway/permission_reviewer.zig`, single attempt). Reviewer unavailable → deny with replan (`tool_admission.zig:830-882`). Subagent-authored prompts can never establish authorization (`TurnOrigin`, `config.zig:14-17`).
- Rules `permissions.zig` (3,616 lines): configured denies first; exact-command fingerprints (`command_admission.zig`); direct read-only command classification (`direct_command.zig`); shell lexing and effect planning (`shell_command/*`).
- Approval request ids: `PermissionActionId = [32]u8` (SHA-256, `runtime/tool_admission.zig:32`); issued on auto-denial (`orchestrator.zig:6171`), redeemable only through `ask_user_question` with the exact id, then live revalidation (`tool_admission.zig:1416`).
- Sandbox ✓ macOS Seatbelt only: `/usr/bin/sandbox-exec -p <profile>` (`sandbox.zig:831`). **No Linux sandbox**: `os` mode is rejected with `unsupported_os_sandbox_message` ✓ (`sandbox.zig:54`). `sandbox.zig` also contains process execution, setsid/subreaper supervision and sandbox-failure heuristics, which are execution concerns.

The decision about who owns permission *policy* (Chip as tool owner, or Attn as application authority) is recorded as OD-4 in [../DECISIONS.md](../DECISIONS.md). Either way it is not FX.

## 4. Execution (Compute)

| Module | Lines | Role |
| --- | ---: | --- |
| `execution/router.zig`, `local_executor.zig`, `command_contract.zig`, `command_environment.zig`, `process_tree.zig`, `background_process_provider.zig`, `devbox_executor.zig` | 2,200 | authorized routing, command results, descendant tracking, remote-exec contract |
| `background/*` | 9,218 | durable background processes, liveness, restore, supervisor, server detection |
| `terminal/*` | 36,538 | hosted terminal sessions (native and tmux), VT engine shared with replay, monitors, write leases, recovery |
| `shell_command/*` | 2,907 | command lexing and effect classification (policy half is Chip/Attn) |
| `permissions/sandbox.zig` | 5,089 | Seatbelt wrapping plus process execution |

None of these is retained in FX.

## 5. Other agent subsystems

| Area | Lines | Tests | Owner |
| --- | ---: | ---: | --- |
| `subagent/` (21 files) | 53,372 | 338 | Chip |
| `mcp/` (36 files incl. features) | 48,096 | 364 | Chip |
| `skills/` | 6,414 | 97 | Chip |
| `hooks/` (in-process: `pre_tool_use`, `stop`, `post_turn_end`, `attention_required`) | 1,621 | 16 | Chip |
| `modes/` (`code` = auto, `ask` = ask) | 179 | 2 | Chip |
| `tasks/` | 532 | 9 | Chip |
| `images/` | 4,368 | 87 | Chip (loading, catalog); FX (image content part) |
| `workspace/` | 16,079 | 255 | Chip (context, indexes); shell (`record_tape`) |

## 6. Tool-call proposals: what the FX contract must represent

How tool calls arrive today (`src/gateway/client.zig:2915-3101`): streamed `tool-input-start/delta/end` records keyed by id (display only), then an authoritative `tool-call`. `types.ToolCall` (`types.zig:612-621`) carries `id, name, arguments_json, argument_integrity, provisional_id, provider_result, final_identity, provenance{fx_local, provider_executed}`. Typed argument decoding happens only later in each tool's `decode`.

Required contract elements (adopted in [../ARCHITECTURE.md](../ARCHITECTURE.md) §4):

1. `ToolDefinition{name, description, input_schema_json, execution: client | provider}` and `ToolChoice{auto, none, required, named}` (today only `auto|none` in the type).
2. `ToolCallProposal{id, name, arguments_json, integrity, identity, source}` with no execution semantics.
3. `ProviderToolRecord{call_id, name, input, result, identity_failure}`: the only case where the provider reports execution, kept distinct from proposals.
4. A typed event union replacing the five callbacks, with streamed tool input marked display-only.
5. A completion envelope admitted by a pure validator equivalent to `authoritativeToolAdmission`.
6. Delivery and attempt evidence so the caller decides replay safety without FX executing anything.
7. Credentials, tenant, endpoint and retry count removed from the contract.
8. Structured output (`response_format`), used by the vision tool and the permission reviewer.

## 7. Test counts in scope

`core/agent` 272; `core/agent/runtime` 166; `core/agent/runtime/tests` 319 (gateway_flow 139, tool_flow 123, finalization_flow 41, interruption_flow 16); `core/tooling` 404; `src/tools` about 405; `src/builtins` 279 + 22; `core/permissions` 241 (sandbox 72); `core/execution` 24; `core/shell_command` 67; `core/background` 84; `core/subagent` 338; `core/mcp` 364; `core/skills` 97; `core/hooks` 16; `core/modes` 2; `core/tasks` 9; `core/images` 87; `core/workspace` 255; `core/terminal` 279.
