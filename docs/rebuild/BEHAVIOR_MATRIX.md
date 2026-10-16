# Behavior-preservation and conformance matrix

The replacement is validated against **observed** current behavior. Each row names the current evidence (code, tests, observed runs), the expected behavior of the rebuilt core, and the conformance test that will prove it. Expected behavior is defined here, before implementation, as the brief requires.

Status of current evidence: **P** passed locally at `255c6cf` ([BASELINE.md](BASELINE.md)); **CI** exists in a deterministic suite that was not run locally; **L** needs live credentials; **GAP** no existing test.

## 1. Conformance harness

- **Fake capability** (`rust/fx-core`, R2): implements `fx_core::Capability` from a scripted list of steps: `emit(Event)`, `set_delivery(possibly_sent)`, `wait_for_cancel`, `sleep(ns)`, `return_error(RunError)`, `return_without_terminal`. Deterministic and allocation-failure aware.
- **Fixture format:** JSON files under `rust/fx-core/tests/fixtures/` (contract fixtures exist from R1 in `fixtures/contract/`; executor fixtures land in R2), each `{ "request": <contract JSON>, "script": [...], "expect": { "outcome": ..., "events": [...], "diagnostics": {...} } }`. One fixture runs unchanged against the native executor, the N-API adapter and the WASM adapter (BM-14).
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
| BM-11 | Concurrent requests and isolation | SDK `test-native-core-workers.mjs`, `test-native-core-config-isolation.mjs` (**P**); N-API 64-slot cap (`test-native-core-misuse.mjs`, **P**) | independent `execute` calls share nothing; per-call arenas; no global mutable state in `src/fx` | `parallel_executions_isolated` (8 threads), static check: no global mutable state in `rust/fx-core` (no `static mut`, no interior-mutable statics) |
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

## 8. R1 contract test map (Rust, `rust/fx-core`)

Every contract behavior introduced by R1 maps to a named deterministic test. None needs a network, credentials or a live model (`CARGO_NET_OFFLINE=true cargo test --locked --offline` passes). Test files are under `rust/fx-core/tests/`; fixtures are in `tests/fixtures/contract/` and listed with their expected result and protected behavior in `cases.json`.

### 8.1 Behaviors and tests

| Behavior | Matrix link | Tests |
| --- | --- | --- |
| One contract version; unknown versions rejected first, deterministically | BM-17 | `contract_roundtrip::unknown_versions_are_rejected`, `unknown_version_is_reported_before_shape_errors`, `missing_and_invalid_version_fields_are_rejected`; fixture `request_unsupported_version` |
| Round trip of every request shape, every event, every outcome and every error kind; canonical encoding | BM-01, BM-03, BM-04, BM-05, BM-06 | `request_full_roundtrip_preserves_every_field`, `request_encoding_is_canonical_and_stable`, `request_minimal_document_uses_documented_defaults`, `request_every_image_media_type_roundtrips`, `request_every_tool_choice_roundtrips`, `event_every_variant_roundtrips`, `outcome_every_variant_and_error_kind_roundtrips`, `capability_error_roundtrips`; every `ok` fixture (also re-encoded and re-decoded by the runner) |
| Observed wire semantics (tool round trip from the built binary) are representable | BM-04 | fixture `request_observed_tool_round_trip`; events `event_tool_input_*`, `event_tool_call`, `event_usage`, `event_finish_tool_calls` |
| Unknown tags and invalid enum values | BM-17, A-1, A-4 | `unknown_part_tags_are_rejected`, `invalid_enum_values_are_rejected`, `unknown_event_and_outcome_tags_are_rejected`, `missing_tags_are_rejected`; fixtures `request_unknown_part_type`, `request_unknown_role`, `event_unknown_type`, `event_finish_unknown_reason`, `outcome_unknown_type`, `capability_error_unknown_kind` |
| Unknown, duplicate and missing fields; wrong types; out-of-range numbers | BM-17 | `unknown_fields_are_rejected_at_every_level`, `unknown_fields_on_empty_tagged_variants_are_rejected`, `duplicate_fields_are_rejected`, `missing_required_fields_are_rejected`, `wrong_json_types_are_rejected`, `out_of_range_numbers_are_rejected`, `request_ids_must_be_32_lowercase_hex_digits`; fixtures `request_unknown_field`, `request_duplicate_field`, `request_missing_messages` |
| Invalid UTF-8, malformed JSON, trailing data | BM-17 | `invalid_utf8_is_rejected_before_parsing`, `malformed_json_is_rejected_with_one_exact_kind_per_input`, `trailing_data_is_rejected`; fixtures `request_invalid_utf8`, `request_trailing_data` |
| Oversized payloads rejected before parsing; boundary values; event and outcome field bounds | BM-17, A-8 | `oversized_request_is_rejected_before_parsing_at_the_exact_boundary`, `oversized_event_and_outcome_documents_are_rejected`, `event_field_bounds_are_enforced_on_decode`, `outcome_bounds_are_enforced_on_decode` |
| Resource limits defined in one place, with pinned defaults | BM-17 | `contract_validation::limits_defaults_are_pinned` and the per-limit boundary tests below |
| Invalid requests rejected before any capability call; first failure, deterministic order; locations without content | BM-07 | `minimal_and_full_requests_are_valid`, `parse_request_decodes_then_validates`, `validation_is_deterministic_and_returns_the_first_failure`, `errors_carry_locations` |
| Model id: empty, syntax, length boundary, opacity | BM-07 | `model_id_bounds_and_syntax`; fixture `request_empty_model` |
| Message and part counts, total text: boundary values | BM-07 | `message_count_bounds`, `part_count_bounds`, `total_text_bounds` |
| Role/content combinations (full matrix) | BM-07 | `role_content_matrix`; fixture `request_role_part_mismatch` |
| History pairing, oracle `validateToolMessageHistory` | BM-07, I10 | `history_orphan_tool_result_is_rejected`, `history_missing_result_at_end_is_rejected`, `history_missing_result_before_next_message_is_rejected`, `history_unmatched_result_is_rejected`, `history_duplicate_result_is_rejected`, `history_result_name_must_match_the_proposal`, `history_duplicate_proposal_ids_are_rejected`, `history_results_may_arrive_in_any_order_across_tool_messages`, `history_extra_tool_message_after_all_results_is_an_orphan`, `history_new_proposals_while_results_pending_are_rejected`, `history_multiple_rounds_are_valid`; fixtures `request_orphan_tool_result`, `request_missing_tool_result`, `request_tool_result_name_mismatch`, `request_duplicate_tool_call_id` |
| Tool-call ids, names, arguments (oracle: any valid JSON, duplicate keys rejected), depth and size bounds | BM-04, BM-07 | `tool_call_id_syntax_and_bounds`, `tool_name_syntax_and_bounds`, `tool_arguments_must_be_valid_json_without_duplicate_keys`, `tool_arguments_depth_and_size_bounds`, `tool_result_bounds_and_json_output`; fixture `request_duplicate_key_arguments` |
| Images: type sniffing against declared type (oracle), empty, per-image, count and total bounds; canonical base64; decoded size bounded before allocation | BM-03 | `image_media_type_must_match_the_bytes`, `image_size_count_and_total_bounds`, `image_base64_must_be_canonical`, `image_decoded_size_is_bounded_before_allocation`, unit tests in `src/base64.rs`; fixtures `request_image_type_mismatch`, `request_noncanonical_base64` |
| Tool definitions: names, duplicates, schema must be a JSON object, provider args only on provider tools, bounds | BM-07 | `tool_definitions_are_validated`, `tool_definition_bounds`; fixture `request_duplicate_tool_name` |
| Tool choice references defined tools | BM-07 | `tool_choice_must_reference_defined_tools`; fixture `request_unknown_named_tool` |
| Options: max tokens, opaque reasoning label (oracle charset and 64-byte bound), response-format name, schema syntax and description bound | BM-03 | `generation_options_are_validated`; fixtures `request_full`, `request_invalid_response_schema` |
| Correlation affinity key; attempt budget is a portable duration with bounds | BM-07, BM-08 | `affinity_key_bounds_and_syntax`, `attempt_budget_bounds`, `request_budget_is_a_portable_duration_in_milliseconds`; fixture `request_zero_budget` |
| Delivery certainty is monotonic | I9, BM-06 | `delivery_certainty_is_monotonic` |
| Cancellation never implies non-execution | BM-08 | `cancellation_never_implies_non_execution`; fixture `outcome_cancelled` |
| Proposals are data; provider records are distinct; malformed proposal arguments are not rejected at decode (normalization is R2) | BM-04, I6 | `event_proposal_with_malformed_arguments_still_decodes`, `event_bounds_do_not_reject_malformed_proposal_arguments`; fixtures `event_tool_call_malformed_arguments`, `event_provider_tool_record` |
| Interrupted stream keeps partial output as a failure, never a completion | BM-10, I3 | fixture `outcome_failed_interrupted`; `outcome_every_variant_and_error_kind_roundtrips` |
| Errors and detail never carry content or secrets; detail bounded at a char boundary | BM-15 | `decode_errors_never_echo_input_content`, `validation_errors_never_contain_request_content`, `detail_is_bounded_and_masks_secrets` |
| No ambient authority, no provider/HTTP/async dependency, pinned dependencies | invariant 9 | `rust/fx-core/check-boundaries.sh` (CI step "Dependency and source boundaries") |
| Contract builds for `wasm32-unknown-unknown` | BM-16 (prerequisite) | CI step "Build wasm32-unknown-unknown" |
| Every fixture file is listed and produces its expected result | all | `contract_fixtures::every_contract_fixture_produces_its_expected_result`, `every_fixture_file_is_listed_in_the_manifest` |

### 8.2 Expected behavior taken from the oracle, not rewritten

- History pairing follows `validateToolMessageHistory` exactly: orphan tool messages, missing or duplicate results, id and name agreement, and duplicate ids within one assistant message are all rejected. The contract allows several results in one tool message, which the oracle expresses as one result per message. The pairing semantics are the same either way.
- Tool-call arguments accept any JSON value, scalar roots included (`consumeSseStream preserves valid serialized scalar roots`). Duplicate keys are malformed (`ToolArgumentIntegrity.classifySerialized`).
- Image media types and magic-byte sniffing match `image_attachments.zig:1549-1552`. The 20 MiB per-image bound matches `max_image_bytes`.
- Reasoning labels use the oracle charset and 64-byte bound (`types.zig:1561-1580`). Detail is clipped to 600 bytes (`client.zig:184`). The event size bound is 32 MiB (`client.zig:188`).
- Secret masking ports the oracle's inline-key, GitHub, AWS, URL-credential and named-assignment patterns (`text_utils.zig:600-720`).

### 8.3 Gaps: behavior not yet representable in the R1 contract

| Gap | Oracle evidence | Owner and step |
| --- | --- | --- |
| Proposal identity and integrity annotations (`final_identity`, `provisional_id`, `argument_integrity`, `ProviderResultIdentityFailure`) on completed proposals | `types.zig:567-621`; `client.zig` identity tests | FX executor, R2 (normalizer output). Done in R2 as `ProposalCheck` (§9); wire encoding R4 |
| Streamed-input fallback and changed-id reconciliation | `consumeSseStream reconciles ...` tests | FX executor. Exact-id fallback done in R2; changed-id reconciliation deferred (§9.4) |
| Completion disposition (`classifyProviderCompletion`) and admission (`authoritativeToolAdmission`) | `types.zig:1123-1290` | FX executor. Done in R2 (`classify`, `admit_proposals`) |
| 1,024-byte tool-description truncation | `gateway_schema.zig:3,61` | Easy-LLM adapter (provider shaping), R3. The contract only bounds descriptions at 64 KiB |
| Generic `*_KEY=` secret heuristic (`matchesSensitiveAssignment`) | `text_utils.zig` | Still open. R2 diagnostics carry no strings besides the request id, so the gap applies only to capability-supplied `Detail`; it moves to R3 with the first real capability |
| Anthropic cache-breakpoint placement policy (`findCacheBreakpoint`) | `gateway_json.zig:752` | Easy-LLM, R3. The contract carries `CacheHint` per message |
| Billing reconciliation by generation id | `generation_usage.zig` | Easy-LLM, R3. The contract carries opaque `generation_id` and `cost` |
| Capability trait, bounded poll batches, cancel and close semantics | RUST_PRIMITIVES §6 | FX. Done in R2 (§9) |

## 9. R2 executor test map (Rust, `rust/fx-core`)

Every executor behavior introduced by R2 maps to a named deterministic test in `rust/fx-core/tests/executor.rs` or to a fixture in `tests/fixtures/executor/` (run by `tests/executor_fixtures.rs`). Each fixture is a request, a fake-capability script and the expected outcome, forwarded events, disposition, proposal checks, admission result and call counts, all as contract JSON, and names the BM row and the oracle test it mirrors. No test needs a network, credentials, a clock or a live model.

### 9.1 Behaviors and tests

| Behavior | Matrix link | Tests and fixtures |
| --- | --- | --- |
| Invalid requests and undecodable documents never invoke the capability | BM-07, invariant 2 | `invalid_requests_never_invoke_the_capability`, `undecodable_documents_never_invoke_the_capability` |
| At most one `start`, exactly one `close` after a successful start, no retry on start or poll failure | BM-06, C6 | `a_valid_request_starts_the_capability_exactly_once_and_closes_it_once`, `a_start_failure_is_not_retried_and_nothing_is_closed`, `a_poll_failure_is_not_retried_and_keeps_partial_output`; fixtures `unauthenticated_start_failure`, `rate_limited_after_send_is_not_retried`, `poll_failure_after_deltas_is_interrupted` (every fixture also checks the fake's counts and zero misuse) |
| Independent and concurrent executions share nothing | BM-11 | `independent_executor_calls_have_independent_attempts`, `parallel_executions_are_isolated` (8 threads); `check-boundaries.sh` forbids global mutable state |
| Budget and bounds reach the capability | BM-08 | `budget_and_bounds_are_passed_to_the_capability` |
| Ordered forwarding, accumulation, reasoning forwarded but not retained | BM-01, BM-02 | `deltas_are_forwarded_in_order_and_accumulated`, `reasoning_is_forwarded_and_counted_but_not_retained`; fixture `text_deltas_complete` |
| Exactly one terminal outcome; `finish` is terminal; later events dropped and never forwarded | I1, I2, A-3 | `finish_is_terminal_and_later_events_are_dropped_not_forwarded`; fixture `finish_is_terminal_late_events_dropped` |
| End of stream without `finish` is interrupted with partial output, never a completion | BM-10, I3 | `a_stream_that_ends_without_finish_is_interrupted_with_partial_output`, `an_empty_stream_without_finish_has_no_partial_output`; fixture `eof_without_finish_keeps_partial` |
| Empty answer with `finish` completes | BM-10 | `an_empty_answer_with_finish_completes`; fixture `empty_finish_completes` |
| Completion disposition (oracle `classifyProviderCompletion`) | BM-05 | `classification_matches_the_oracle`; fixtures `content_filter_is_provider_failure`, `proposals_with_stop_are_invalid`, `usage_fields_merge_without_guessing` (length) |
| Final arguments win; exact-id ended fallback only; open streams and conflicting names lend nothing | BM-04, I5 | `final_arguments_win_over_streamed_input`, `absent_arguments_fall_back_to_an_ended_stream_with_the_same_id_and_name`, `an_open_stream_never_lends_arguments`, `a_conflicting_streamed_name_is_flagged_and_lends_nothing`, `an_overflowed_stream_never_lends_arguments`; fixtures `observed_tool_round_trip_proposal`, `absent_final_input_uses_ended_stream`, `open_stream_never_lends_arguments`, `conflicting_streamed_name_rejected_at_admission` |
| Malformed or duplicate-key arguments replaced by `{}` and flagged; still admissible | BM-04, I6 | `malformed_arguments_are_replaced_with_an_empty_object`; fixtures `malformed_arguments_replaced`, `duplicate_key_arguments_replaced` |
| Duplicate and empty ids preserved and refused by admission; missing arguments refused first | BM-04, I7 | `empty_and_duplicate_ids_are_preserved_flagged_and_refused_by_admission`, `missing_arguments_are_refused_by_admission`; fixture `duplicate_final_ids_preserved_for_admission` |
| Unmatched streamed events are anomalies, not state | BM-04 | `unmatched_streamed_events_are_dropped_as_anomalies` |
| Proposals are data; FX executes nothing | invariant 5 | `proposals_are_data_and_never_execute` |
| Provider records only for declared provider tools; first final result wins | BM-04, I8, invariant 6 | `provider_records_are_accepted_only_for_declared_provider_tools`, `the_first_final_provider_result_wins`; fixtures `provider_record_for_local_tool_fails_closed`, `provider_record_first_final_wins` |
| Usage merged field by field, absent stays unknown; metadata first value wins | BM-05 | `usage_merges_field_by_field_and_absent_fields_stay_unknown`, `metadata_keeps_the_first_value_and_counts_conflicts`; fixture `usage_fields_merge_without_guessing` |
| Delivery certainty is reported honestly and never regresses | BM-06, I9, invariant 3 | `an_unsent_start_failure_stays_definitely_unsent`, `a_failure_after_dispatch_is_possibly_sent`, `a_received_event_confirms_the_response`, `delivery_certainty_never_regresses` |
| C1 cancel before start sends nothing | BM-08 | `cancellation_before_start_sends_nothing`; fixture `cancel_before_start_never_invokes` |
| C2, C3 cancel during the stream keeps observed delivery and partial output; remote status is what the capability reports | BM-08, invariant 4 | `cancellation_during_the_stream_reports_observed_delivery_and_partial_output`, `confirmed_remote_cancellation_still_may_have_executed`; fixture `cancel_during_stream_is_unconfirmed` |
| C4 repeated cancel is one cancel; cancel after finish is ignored | BM-08 | `repeated_cancellation_requests_cancel_once_and_cancel_after_finish_is_ignored` |
| C5 abandonment cancels and closes once | BM-09 | `observer_abandonment_cancels_and_closes_once` |
| A stalled capability is bounded; a capability timeout keeps its delivery | BM-08, C7 | `a_stalled_capability_is_bounded_by_the_poll_limit`, `a_capability_reported_timeout_is_a_failure_with_its_delivery` |
| Event size, empty identifiers, batch size, event, proposal and accumulation bounds | A-8, BM-17, invariant 7 | `oversized_events_are_resource_limits`, `empty_event_identifiers_are_protocol_violations`, `a_batch_larger_than_requested_is_a_protocol_violation`, `event_and_proposal_counts_are_bounded`, `accumulation_is_bounded_while_deltas_are_forwarded_in_full`; fixture `oversized_event_is_a_resource_limit` |
| Diagnostics hold no content; counts are exact | BM-15, invariant 8 | `diagnostics_never_contain_content` (secret-shaped prompt, image, arguments, tool output, affinity key), `diagnostics_count_calls_and_bytes` |
| Pinned `Limits` defaults including the R2 bounds | BM-17 | `contract_validation::limits_defaults_are_pinned` |
| Portability: no clock, thread, async, I/O or global state in the core; builds for `wasm32-unknown-unknown` | BM-16, invariant 9 | `check-boundaries.sh`; CI step "Build wasm32-unknown-unknown" |
| Every executor fixture produces its expected result and cites its oracle | BM-14 (prerequisite) | `executor_fixtures::every_executor_fixture_produces_its_expected_result`, `executor_fixtures_are_deterministic` |

### 9.2 Parity with the oracle

Expected results come from the oracle tests cited in each fixture's `oracle` field and in the test comments; none was changed to match the Rust implementation. One divergence found while writing the fixtures was fixed in Rust rather than in the expectation: an absent final input with no exact ended stream is now refused by `admit_proposals` (`MissingArguments`), as `authoritativeToolAdmission` refuses it with `invalid_tool_input` or `incomplete_streamed_input` (`client.zig:3050-3080`, `consumeSseStream rejects absent outer input without exact ended fallback`).

### 9.3 Intentional differences (fail closed)

| Difference | Oracle | Rust | Reason |
| --- | --- | --- | --- |
| Provider record for an undeclared or local tool, an id colliding with a proposal, or a malformed record | rejected at admission (`reject_malformed_provider_result`) | the stream fails with `ProtocolViolation` and the capability is cancelled | the typed contract declares provider tools up front, so the executor can reject immediately instead of carrying a poisoned completion |
| `finish_reason = tool_calls` with no proposal and no provider record | classified by the caller | `Disposition::InvalidCompletion` | nothing to act on; fails closed |
| Missing arguments placeholder | `""` | `"{}"` with `integrity: Replaced`, `source: Missing`, and refused by admission | proposals in a completion always carry valid JSON (I6); admission still refuses them |
| Events after `finish` in the same batch | ignored | dropped, not forwarded, counted as anomalies in diagnostics | same behavior, now observable |
| Interrupted stream | `GatewayInterrupted` with partial content | `Failed { origin: Executor, kind: Transport, partial }` | the contract's single failure shape |

### 9.4 Deferred gaps

| Gap | Owner and step |
| --- | --- |
| Live replay of the fixtures through the Zig oracle's `consumeSseStream` | Would need a Zig test harness; R2 keeps `src/` unchanged. Revisit in R5 before the legacy seam is deleted |
| Streamed changed-id reconciliation (`findEquivalentEndedStreamedToolInput`, structural matching of a final call to a stream with a different id) | FX executor, when a capability is shown to need it (R3) |
| Wire encoding of `ExecutionReport` (proposal checks, disposition, diagnostics) | R4, with the adapters that consume it |
| Interrupting a blocking `poll` | Not possible without a clock or thread in the core; R4 adapters drive `poll` from the host loop (RISKS R-22) |
| Generic `*_KEY=` secret heuristic for capability-supplied `Detail` | R3 (§8.3) |
| Throughput micro-benchmark | R6 |
