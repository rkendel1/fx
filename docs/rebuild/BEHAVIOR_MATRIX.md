# Behavior-preservation and conformance matrix

The replacement is validated against **observed** current behavior. Each row names the current evidence (code, tests, observed runs), the expected behavior of the rebuilt core, and the conformance test that will prove it. Expected behavior is defined here, before implementation, as the brief requires.

Status of current evidence: **P** passed locally at `255c6cf` ([BASELINE.md](BASELINE.md)); **CI** exists in a deterministic suite that was not run locally; **L** needs live credentials; **GAP** no existing test.

## 1. Conformance harness

- **Fake capability** (`src/fx/testing/fake_capability.zig`, PR 2): implements `contract.Capability` from a scripted list of steps: `emit(Event)`, `set_delivery(possibly_sent)`, `wait_for_cancel`, `sleep(ns)`, `return_error(RunError)`, `return_without_terminal`. Deterministic and allocation-failure aware.
- **Fixture format:** JSON files under `src/fx/testing/fixtures/*.json`, each `{ "request": <contract JSON>, "script": [...], "expect": { "outcome": ..., "events": [...], "diagnostics": {...} } }`. One fixture runs unchanged against the native executor, the N-API adapter and the WASM adapter (BM-14).
- **Fixture sources:** the SSE scripts already embedded in `src/gateway/client.zig` tests and `tests/e2e/gateway-stream-lifecycle.test.ts` are translated once into contract-event fixtures. The AI SDK v3 JSON shapes themselves are handed to Easy-LLM's adapter suite (§3).
- **No live model and no Vercel account** is needed for any core conformance test. An optional `zig build test-easy-llm-smoke` runs a reduced suite against a real Easy-LLM capability when one is configured; it is never a merge gate.
- **Existing failures are reported separately.** The 11 environment-specific failures in [BASELINE.md](BASELINE.md) and any failure that also reproduces on `main` are recorded as pre-existing, not as regressions, and are never waived silently. A build-only check never counts as functional evidence.

## 2. Required behavior matrix

| ID | Behavior | Current evidence | Expected behavior in the rebuilt core | Conformance tests |
| --- | --- | --- | --- | --- |
| BM-01 | Ordinary request and successful completion | `fx ask --json` against the loopback fake returns `output`, exit 0 (**P**, [evidence](evidence/observed-wire.md)); `stream provider dispatches request and preserves ordered callbacks` (**P**) | `execute` returns `completed` with concatenated text, `finish_reason = stop`, disposition `complete` | `basic_text_completion`, `completion_preserves_model_reported_and_generation_id` |
| BM-02 | Incremental text streaming | callbacks fire per delta in order on the calling thread (`direct gateway core callbacks stay on the invoking thread`, **P**); SDK `test-native-core-stream.mjs` "split terminal tail" (**P**) | observer receives every `text_delta` in order before `finish`; concatenation equals `Completion.content`; reasoning deltas forwarded, counted, not retained | `deltas_forwarded_in_order`, `reasoning_forwarded_not_retained`, `content_limit_truncates_accumulation_not_forwarding` (GAP today) |
| BM-03 | Structured content and options | `responseFormat` encoding and validation (`gateway_json.zig` tests, **P**); vision structured output (`vision-route-fake-gateway.test.ts`, **CI**); image parts (`image_attachments` tests, **P**) | request validation accepts `response_format` with parseable schema, rejects malformed schema as `invalid_request` before any capability call; image parts pass through unchanged | `response_format_schema_must_parse`, `image_part_round_trip`, `options_forwarded_verbatim` |
| BM-04 | Tool-call proposal representation | identity, integrity, fallback and provider-result tests in `client.zig` (about 40, **P**); observed round trip ([evidence](evidence/observed-wire.md)) | proposals normalized per invariants I5-I8; provider-executed records separate; streamed input never authoritative; `admitProposals` rejects duplicate ids, malformed ids, malformed provider results and arguments | `proposal_final_input_wins`, `proposal_streamed_fallback_exact_id_only`, `proposal_conflicting_name_rejected`, `proposal_malformed_json_replaced`, `provider_record_requires_provider_call`, `admission_rejects_duplicates` |
| BM-05 | Finish reasons and usage | `consumeSseStream preserves provider finish_reason`, `... captures exact terminal billing`, `... ignores malformed finish usage totals` (**P**) | six-value `FinishReason`; usage fields copied when present, absent when malformed (never guessed); `cost` and `generation_id` opaque | `finish_reason_each_value`, `usage_partial_fields`, `usage_malformed_dropped` |
| BM-06 | Provider-independent errors | mapping in ARCHITECTURE §8; `native network failure evidence ...` (**P**); `gateway retry policy covers rate limits ...` (**P**); `server error response preserves billing ambiguity` (**P**) | every `ErrorKind` reachable from the fake; `delivery` and `retry_after_ms` preserved; `detail` bounded and masked | one test per `ErrorKind`; `retry_after_preserved`, `detail_masked_and_bounded` |
| BM-07 | Invalid request handling | `validateToolMessageHistory` tests (**P**); `InvalidGatewayHistory` | invalid requests fail with `invalid_request` and `definitely_unsent`, with **zero** capability calls | `history_pairing_enforced`, `tool_result_in_wrong_role_rejected`, `named_tool_choice_must_exist`, `duplicate_tool_names_rejected`, `empty_model_rejected` |
| BM-08 | Cancellation before, during execution, during streaming | `direct gateway cancellation before admission opens no connection` (**P**), `direct gateway cancellation closes a stalled response body promptly` (**P**), `bounded stream cancellation ...` (**P**), `gateway_flow.zig` cancellation cases (**P**), SDK `test-native-core-cancel*.mjs` (**P**), `test-core-cancel.mjs` (**CI**) | C1-C5 in ARCHITECTURE §9 | `cancel_before_run_no_capability_call`, `cancel_during_run_reports_delivery`, `cancel_during_stream_stops_forwarding`, `double_cancel_noop`, `cancel_after_terminal_noop` |
| BM-09 | Consumer abandonment and cleanup | SDK `test-native-core-worker-termination.mjs` "active stalled runtime finalized within 5s" (**P**); no core-level equivalent (**GAP**) | `Flow.stop` cancels the capability, waits for return, frees all executor state | `observer_stop_cancels_and_frees`, allocation-failure sweep over abandonment |
| BM-10 | Empty, partial and interrupted responses | `consumeSseStream preserves partial content without finish proof at EOF`, `... treats done before finish as framing only`, `... propagates read failure before finish` (**P**); E2E "missing provider finish recovers across framing and content variants" (**CI**) | no terminal event → `interrupted` with partial completion; empty stream with `finish{stop}` → `completed` with empty content; capability error after events → `failed` preserving delivery | `eof_without_finish_is_interrupted`, `empty_finish_is_complete`, `error_after_deltas_keeps_partial_for_caller` |
| BM-11 | Concurrent requests and isolation | SDK `test-native-core-workers.mjs`, `test-native-core-config-isolation.mjs` (**P**); N-API 64-slot cap (`test-native-core-misuse.mjs`, **P**) | independent `execute` calls share nothing; per-call arenas; no global mutable state in `src/fx` | `parallel_executions_isolated` (8 threads), static check: no `var` at container scope in `src/fx` |
| BM-12 | Native API and N-API compatibility | current N-API lane 12/12 (**P**) for the ACP-shaped API | new N-API surface passes the shared fixtures; handle misuse, use-after-destroy, worker termination and slot-cap cases ported from today's scripts | `napi_conformance.mjs` running every fixture; ported `misuse`, `workers`, `worker-termination` |
| BM-13 | Easy-LLM integration and explicit binding | today: compile-time provider choice (`main.zig:430-435`) | FX builds and passes with only the fake capability; the Easy-LLM capability is passed by the caller; no default capability exists | `no_default_capability` (compile test), optional `test-easy-llm-smoke` |
| BM-14 | Runtime adapter conformance | today: host provider lacks tool-input streaming, retry-after and network evidence ([audit/01](audit/01-inference-path.md) §1) | identical normalized events and outcomes on native, N-API and WASM for every fixture | fixture runner per adapter; diff of outcome JSON must be empty |
| BM-15 | Secret redaction and diagnostics | `consumeSseStream unfiltered trace excludes all payload keys and values`, `... traces every SSE event with keyless metadata` (**P**); `debug_trace` keyless preview tests (**P**) | diagnostics and trace contain ids, counts, timings, terminal cause only | `diagnostics_contain_no_content` with secret-shaped inputs (`sk-...`, `Bearer ...`, `github_pat_...`) |
| BM-16 | WASM host-capability restrictions | WASI shim stubs filesystem imports (`fx-sdk.js:739-760`); JSPI required today | reactor module imports nothing but `fx_trace` and `fx_now_ms`; instantiation without any other import succeeds; no JSPI needed | `wasm_import_allowlist` (inspect module imports), `wasm_runs_without_jspi` |
| BM-17 | Regression tests for retained public contracts | existing contract-level tests listed above | every retained invariant (I1-I10, C1-C7) has at least one named test; the list is checked by a script against this file | `invariant_coverage` check in CI |

## 3. Adversarial cases

Defined before implementation; each must produce the stated outcome on every adapter.

| ID | Case | Expected | Existing evidence |
| --- | --- | --- | --- |
| A-1 | Malformed event payload from capability (wrong union tag in JSON adapters, invalid UTF-8 in text) | `failed{protocol_violation}`; previously forwarded events stay valid | `SseEventReader` skips malformed JSON lines today (traced); **behavior change**: the typed boundary cannot carry "malformed" events natively, so JSON adapters reject them. Recorded in [RISKS.md](RISKS.md) R-9 |
| A-2 | Event after terminal | dropped, `anomalies += 1` | `consumeSseStream ignores conflicting and late stream events without mutation` |
| A-3 | Two `finish` events | first wins; second counted as anomaly | GAP |
| A-4 | `finish` with unknown or empty reason | `failed{protocol_violation}`; proposals not admitted | `consumeSseStream rejects malformed provider finish reasons`; E2E `empty provider finish reason fails closed before tool execution` |
| A-5 | Final tool call whose name conflicts with the streamed name | proposal identity rejected | `consumeSseStream rejects a final tool name that conflicts with streamed identity` |
| A-6 | Duplicate proposal ids | both preserved; `admitProposals` rejects | `consumeSseStream preserves duplicate final ids for duplicate admission` |
| A-7 | Provider tool result for a client-executed call | rejected with `ProviderResultIdentityFailure` | `consumeSseStream rejects provider results for local calls` |
| A-8 | Oversized single event | `failed{response_too_large}` | `SseEventReader rejects an over-limit event explicitly` |
| A-9 | Double cancellation, cancel racing finish | exactly one terminal outcome; cancel after finish ignored | `bounded stream cancellation wins when observable while deadline cleanup completes`, `... discards a successful result when cancellation wins before return` |
| A-10 | Capability returns without any terminal event and without error | `interrupted` (if any content) or `failed{protocol_violation}` (if none) | `consumeSseStream frees unfinished streamed state at EOF` |
| A-11 | Capability returns `CapabilityUnavailable` | `failed{capability_unavailable, definitely_unsent}` unless delivery was marked | `unavailable_provider` behavior |
| A-12 | Allocation failure at every allocation site | no leak; `error.OutOfMemory` or a well-formed `failed` | `consumeSseStream frees all response state across allocation failures` |
| A-13 | Delivery certainty set back from `possibly_sent` to `definitely_unsent` | ignored (monotonic) | `DeliveryCertainty` atomic store semantics |

## 4. Disposition of the 120 `src/gateway/client.zig` tests

| Group | Approx. count | Disposition |
| --- | ---: | --- |
| SSE event semantics: finish, partial, terminal causes, usage, provider error detail | 20 | Port to FX normalizer tests over typed events (BM-02, BM-05, BM-10) |
| Tool-call identity, integrity, fallback, provider results | 40 | Port to FX normalizer tests (BM-04, A-2..A-7) |
| Billing and generation metadata (`providerMetadata.gateway.*`, `gen_` ids, timestamps) | 8 | Easy-LLM adapter suite |
| SSE framing, buffer boundary, oversize line, CRLF, keyless trace of SSE | 10 | Framing to Easy-LLM; oversize and trace policy mirrored in FX (A-8, BM-15) |
| Connection setup, TLS retry, response retry, agent vs transport attempts, delivery certainty | 20 | Easy-LLM transport suite; delivery-certainty semantics mirrored in FX (BM-06, A-13) |
| Cancellation and deadlines over real loopback sockets, suspend detection, watcher | 18 | Easy-LLM transport suite; executor-level cancellation re-proven with the fake (BM-08) |
| Headers, URL gating, resolved-model headers, team header | 6 | Easy-LLM (Vercel-specific ones REMOVE) |

`src/core/agent/runtime/tests/gateway_flow.zig` (139 tests) exercises the agent loop's recovery over the seam. Its retry, Fast fallback, 401 refresh and checkpoint cases move to Chip with `model_response_recovery`; its single-attempt classification cases are mirrored in BM-06/BM-10.

## 5. E2E classification (all 59 root `*.test.ts` files)

PGSO corpus class is from `scripts/pgso/corpus.json` (T = training, V = verification-only, X = intentional exclusion). Any file that is moved or removed must have its corpus entry removed in the same PR (`AGENTS.md`, "Adding a Feature").

| File | Cases | PGSO | Behavior it protects | Target | Relationship to FX conformance |
| --- | ---: | --- | --- | --- | --- |
| `gateway-stream-lifecycle.test.ts` | 56 | T | end-to-end stream lifecycle through the binary | FX (fixtures) + shell | **Primary fixture source** for BM-02/04/05/10/A-* |
| `tui-gateway-stream-lifecycle.test.ts` | 68 | T | the same lifecycle rendered in the TUI | shell | mirrors FX fixtures; rendering stays with the shell |
| `session-recovery.test.ts` | 7 | T | durable recovery after interrupted delivery | Chip | delivery-certainty inputs come from FX (BM-06) |
| `tui-interrupt-recovery.test.ts` | 3 | T | interrupt and resume | shell / Chip | cancellation inputs from FX (BM-08) |
| `vision-route-fake-gateway.test.ts` | 35 | T | vision tool, structured output | Chip | structured-output requests (BM-03) |
| `web-search-fake-gateway.test.ts` | 17 | T | provider-executed search | Chip | provider tool records (BM-04) |
| `tui-cost.test.ts` | 6 | V | cost display | shell | `cost` opacity (BM-05) |
| `acp.test.ts` | 98 | T | ACP protocol | Chip | none |
| `cli.test.ts` | 92 | T | CLI commands | shell | none |
| `ask-presentation.test.ts` | 12 | T | `fx ask` output | shell | none |
| `config-persistence.test.ts` | 28 | T | settings | shell | none |
| `prompt-history.test.ts` | 4 | T | prompt history | shell | none |
| `auth-refresh.test.ts` | 7 | T | Vercel OAuth refresh | REMOVE | none |
| `oauth-keychain-migration.test.ts` | 2 | V | credential storage migration | Easy-LLM | none |
| `tui-auth-source-selection.test.ts` | 28 | V | Vercel credential picker | REMOVE | none |
| `file-tool-paths.test.ts`, `file-tool-permissions.test.ts` | 16, 2 | T | file tools | Chip | none |
| `permission-errors.test.ts`, `yolo-permission-mode.test.ts`, `auto-mode-reliability.test.ts` | 5, 4, 15 | T, V, V | permissions | Chip | none |
| `mcp-auth.test.ts`, `mcp-http.test.ts`, `mcp-legacy-remote.test.ts`, `mcp-stdio.test.ts` | 31, 28, 25, 72 | T | MCP | Chip | none |
| `web-fetch-fake-network.test.ts`, `web-fetch-permission-progress.test.ts`, `web-search-permission-progress.test.ts` | 8, 1, 2 | T, V, V | web tools | Chip | none |
| `web-fetch-live.test.ts`, `web-search-live.test.ts`, `context-limits-live.test.ts` | 3, 1, 1 | X | live behavior | Chip | none |
| `terminal-host.test.ts`, `tui-terminal-tool.test.ts` | 85, 24 | T | hosted terminals | Compute | none |
| `notifications.test.ts` | 5 | X | sound cues | shell | none |
| `ci-shards.test.ts`, `tmux-helpers.test.ts` | 7, 10 | X | harness | shell | none |
| `tui-agent.test.ts`, `tui-startup.test.ts`, `tui-resize.test.ts`, `tui-render-*.test.ts` (5 files), `tui-full-transcript-brutal.test.ts`, `tui-resume*.test.ts` (2), `tui-slash-*.test.ts` (3), `tui-subagent-manager.test.ts`, `tui-keybindings.test.ts`, `tui-input-*.test.ts` (2), `tui-composer-edit-contracts.test.ts`, `tui-file-picker.test.ts`, `tui-native-clear-recovery.test.ts`, `tui-direct-write-audit.test.ts`, `tui-decision-prompts.test.ts`, `tui-permissions.test.ts`, `tui-command-permissions.test.ts` | see `inventory/files.tsv` | T/V/X per corpus | TUI behavior | shell | none |

Exact per-file case counts are in [inventory/files.tsv](inventory/files.tsv) (`tests` column).

## 6. SDK test scripts

| Script | Today | Target |
| --- | --- | --- |
| `test-native-core.mjs`, `-stream`, `-cancel`, `-cancel-before-fetch`, `-fetch-failure`, `-exit-code`, `-misuse`, `-security`, `-config-isolation`, `-workers`, `-worker-termination`, `test-libfx-loader.mjs` | **P** (12/12) | Ported to the new N-API surface (BM-08, BM-09, BM-11, BM-12); ACP-specific assertions (`session/new`, MCP rejection) move to Chip |
| `test-core.mjs`, `test-core-cancel.mjs`, `test-core-home-unavailable.mjs`, `test-node-wasm.mjs`, `test-browser-wasm.mjs`, `test-core-browser.mjs` | **CI** (needs Node 24 JSPI) | Rewritten for the reactor module (BM-14, BM-16) |
| `test-core-live.mjs` | **L** | Becomes the optional Easy-LLM smoke |
| `test-term*.mjs`, `sdk/node/*.mjs` | **CI** | Move with the browser terminal (shell) |
| `test-term-login.mjs` | **CI** | REMOVE (Vercel device login) |
| `test-sdk.mjs` | unreferenced | REMOVE |

## 7. Documented test gaps (no current test)

1. `host_stream_provider.stream` success, cancel and open-failure paths.
2. `js_host_stream_provider.zig`, `js_host_model_catalog.zig`, `gateway_failure_diagnostics.zig` (zero tests).
3. Native non-200 error body size bound (unbounded today).
4. HTTP-date `retry-after`.
5. `content_capture_limit` truncation while callbacks receive full deltas.
6. Reasoning not retained in the completion.
7. Two `finish` events (A-3).
8. Consumer abandonment at the core level (BM-09).

Items 1-2 and 3-4 become Easy-LLM's (they are transport). Items 5-8 are covered by the new FX conformance tests named above.
