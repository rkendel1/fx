# Audit 01: Inference path

Scope: `src/core/agent/stream_provider.zig`, `src/gateway/*`, `src/core/gateway/*`, `src/builtins/gateway.zig`, `src/builtins/gateway/permission_reviewer.zig`, `src/core/shared/types.zig` (inference subset), `src/core/config/model_capabilities.zig`, `src/core/tooling/gateway_schema.zig`, `src/core/tooling/model_request_budget.zig`, `src/core/agent/runtime/{gateway_step,assistant_stream,model_response_recovery,image_provider}.zig`, `src/core/app/model_cache_runtime.zig`.

Method: complete read of the listed files plus call-site tracing. Line numbers refer to commit `255c6cf`. Claims marked ✓ were re-verified directly against the source while writing this note.

## 1. The provider seam as it exists

The brief names `ModelProvider.chat(ChatRequest) → ChatStream`. **That interface does not exist in this repository.** The actual seam is `stream_provider.Provider` ✓ (`src/core/agent/stream_provider.zig:178-192`):

```zig
pub const Provider = struct {
    context: ?*anyopaque = null,
    build_fn: BuildFn = unavailableBuild,   // (ctx, alloc, BuildRequest) anyerror![]u8
    stream_fn: StreamFn,                    // (ctx, alloc, Request) anyerror!Result
};
```

| Symbol | Line | Shape | Finding |
| --- | --- | --- | --- |
| `StreamCallback`, `ToolStartCallback` | 10-16 | void callbacks with `*anyopaque` context | No terminal event; no way for the consumer to stop the stream |
| `DeliveryCertainty` | 20-39 | atomic `{definitely_unsent, possibly_sent}`, monotonic | Provider-neutral and valuable (decides whether a retry could double-bill) |
| `ProviderAttemptOwner` | 43-46 | `{transport, agent}` | Exists only because retries happen in two layers |
| `NetworkFailureCause/Evidence`, `AttemptEvidence` | 48-63 | out-parameters | Neutral evidence, but delivered by side channel |
| `CooperativePulse` | 67-74 | host yield callback | Needed by single-threaded hosts |
| `VisionMode` | 76-80 | tool advertisement policy | Agent concern leaking into the seam |
| `BuildBudget` | 82-85 | cancel flag + deadline | Neutral |
| `StructuredResponseFormat` | 87-91 | `{name, description, schema_json}` | Neutral |
| `BuildRequest` | 93-106 | `model, tool_registry, serialized_tools, messages, tool_choice, selected_dynamic_tool_schemas, vision_mode, provider_options, max_output_tokens, budget, verified_images, response_format` | Carries the agent's tool registry and pre-serialized tool JSON |
| `Request` | 108-129 | `api_key, team, session_id, model, retry_count, chat_url, payload, trace_ctx, content_capture_limit, cooperative_pulse, delivery, attempt_evidence, callback_ctx, on_*_chunk, cancel_flag, provider_attempt_owner` | **Credential, tenant, endpoint and retry count are in the core contract**; `payload` is opaque wire bytes |
| `Result` | 136-164 | `status: std.http.Status, completion: GatewayCompletion, err_body, generation_origin, reconcile_generation_usage, failure_schema, failure_request_shape, retry_after_seconds, ownership` | HTTP status as the outcome; Gateway billing reconciliation fields |
| `unavailable_provider` | 202 | both fns return `error.AgentStreamProviderUnavailable` | |

Verdict for Primitive 2 ("evaluate the existing interface"): the shape (a context pointer plus function table, single synchronous call with incremental callbacks, monotonic delivery evidence) is sound and fits Zig and both embedding targets. The content leaks provider and agent details. Specifically:

1. `api_key`, `team`, `chat_url`, `retry_count` are provider/routing/credential data owned by Easy-LLM.
2. `build_fn` returns opaque wire bytes, so the core never holds a typed request it could validate or a different backend could consume.
3. `BuildRequest.tool_registry` and `vision_mode` are agent-tool concerns.
4. `Result.status` makes HTTP the outcome vocabulary; `generation_origin` and `reconcile_generation_usage` are Vercel billing reconciliation.
5. Errors are `anyerror` (no bounded set).

It should not become a supported contract as is, and no second interface should sit next to it. The rebuild replaces it in place (see [../ARCHITECTURE.md](../ARCHITECTURE.md) §4).

### Second-level bundle

`gateway_provider.Provider` ✓ (`src/core/gateway/gateway_provider.zig:89-98`) aggregates eight sub-providers: `agent_stream`, `oauth_transport`, `chat_url`, `cli_model_catalog`, `credits`, `generation_usage`, `web_search`, `model_catalog`. Only `agent_stream` is inference execution; the other seven are provider/account/catalog services (Easy-LLM) or a tool (web search, Chip). `CapabilityResolver` (`:143-232`) is a one-shot catalog cache.

### Implementations and callers

| Implementation | Location | Notes |
| --- | --- | --- |
| Native production | `src/builtins/gateway.zig:126-129` ✓ (`buildAgentRequest` :142, `streamAgentCompletion` :423) | Calls `gateway_client.streamGatewayCompletion`; on error fills `attempt_evidence.network_failure` via `networkFailureEvidence` (:453); sets `generation_origin`, `reconcile_generation_usage = true` (:456-468) |
| Host transport (N-API, WASM) | `src/gateway/host_stream_provider.zig:10-123` | `Transport{open,status,next,close}` with integer handles (-2 cancelled, -3 would-block, 0 EOF); reuses `buildAgentRequest`; decodes with `consumeGatewaySseStream` |
| JS host | `src/gateway/js_host_stream_provider.zig:14-47` | `extern "fx" fx_http_stream_{open,status,next,close}`; selected by `main.zig:430-435` ✓ at comptime on WASM |
| Test fakes | `stream_provider.zig:206`, `gateway_provider.zig:234`, `agent/runtime/tests/support.zig:264`, `app/app_agent_runtime.zig:1663`, `gateway_step.zig:382`, `builtins/gateway.zig:1521`, `permission_reviewer.zig:263` | |

The **only** caller of `Provider.stream` is `gateway_step.streamGatewayCompletion` (`src/core/agent/runtime/gateway_step.zig:27-150`, call at :56). Callers of that wrapper: the agent loop (`orchestrator.zig:2973`, after `build` at :2900) and the vision path (`image_provider.zig:53,77`, model hard-coded `google/gemini-2.5-flash` at :13).

Two consumers **bypass the seam** and call `gateway_client` directly with their own `gateway_json` payloads:

- web search worker: `src/builtins/gateway.zig:911` → `streamGatewayProviderToolCompletionBounded`
- automatic permission reviewer: `src/builtins/gateway/permission_reviewer.zig:214` → `streamGatewayRequiredToolCompletionBounded`

So there are already three inference entry paths with different retry, deadline and usage behavior. The rebuild collapses them to one.

### Host provider gaps relative to native

`host_stream_provider.stream` (`:56-123`):
- ignores `retry_count`, `provider_attempt_owner`, `trace_ctx`, `on_tool_input_chunk`
- never sets `attempt_evidence.network_failure`, so host failures are never auto-retried (test `does not retry opaque JS host stream failures`, `agent/runtime/tests/gateway_flow.zig:4293`)
- leaves `generation_origin = ""`, so no billing reconciliation
- does not parse `retry-after`
- calls `delivery.markPossiblySent()` before `transport.open` ✓ (`:85`), which is conservative but loses "definitely unsent" when open fails

These are behavior differences between runtime surfaces today; the conformance suite must decide which is correct and hold every adapter to it.

## 2. Request construction

### Endpoint and headers

- Chat URL `https://ai-gateway.vercel.sh/v3/ai/language-model` (`builtins/gateway.zig:41`); override `FX_GATEWAY_CHAT_URL` honored only for loopback HTTP (`resolveChatUrl`, :752-758); `FX_E2E_GATEWAY_CHAT_URL` must be loopback or `error.InvalidE2EGatewayUrl` (`client.zig:1174`, 1769-1777).
- Headers (`gatewayExtraHeaders`, `client.zig:1459-1494`): `Authorization: Bearer`, `Content-Type`, `User-Agent: fx/<version>`, `HTTP-Referer: https://github.com/vercel-labs/fx`, `X-Title: fx`, `ai-gateway-protocol-version: 0.0.1`, `ai-language-model-specification-version: 4`, `ai-language-model-id`, `ai-language-model-streaming: true`, optional `x-vercel-ai-gateway-team`, `x-session-id`, `x-session-affinity`. Confirmed on the wire ([../evidence/observed-wire.md](../evidence/observed-wire.md)).

### Body

`buildGatewayRequestBodyValidated` (`src/core/gateway/gateway_json.zig:292-362`):

```text
{"prompt":[...], "tools":<json>, "toolChoice":{"type":"auto"|"none"|"required"},
 ["responseFormat":{"type":"json","name","description","schema"}],
 ["maxOutputTokens":N], ["reasoning":"<effort>"],
 ["providerOptions":{"gateway":{"speed":"fast"},"xai":{"parallelToolCalls":bool}}],
 ["headers":{"user-agent":"fx/x"}]}
```

- Messages (`writeChatMessageJsonInner`, :519-633): system string; user `text` and `file{mediaType,data(base64)}` parts; assistant `text` and `tool-call{toolCallId,toolName,input}`; tool `tool-result{toolCallId,toolName,output{type:"text",value}}`.
- Prompt caching: for `anthropic/` models only (`model_capabilities.zig:84-92`), every system message plus one breakpoint (`findCacheBreakpoint`, :752) gets `providerOptions.anthropic.cacheControl = ephemeral`; a `.no_cache` message disables caching for later messages (:335).
- History validation ✓ `validateToolMessageHistory` (:445): every assistant tool call must be followed by exactly one matching tool result by id and name; orphan tool messages, malformed or duplicate argument JSON fail with `error.InvalidGatewayHistory`. This is a provider-neutral invariant.
- Tools: `{"type":"function","name","description","inputSchema"}` from `gateway_schema.zig:83-93`, description capped at 1,024 bytes; provider-executed tools `{"type":"provider","id":"gateway.perplexity_search"|"gateway.parallel_search",...}` (`builtins/gateway.zig:876-909`).
- `ToolChoice` is `{auto, none}` in `types.zig:1546`; `"required"` exists only as a string literal in specialized builders (`gateway_json.zig:159-205`).
- Max tokens: from capabilities only when smaller than the context window (`orchestrator.zig:1730`); workers hard-code 4,096 (web search, `builtins/gateway.zig:794`) and 2,048 (reviewer, `auto_classifier.zig:345`).
- Reasoning: top-level `"reasoning"` only for non-default effort declared by the catalog (`model_capabilities.zig:194-206`). Fast mode: `providerOptions.gateway.speed = "fast"` if the catalog declares `supports_fast_mode`.
- Model ids are Gateway slugs `provider/model`; capability heuristics key off the prefix (`model_capabilities.zig:84,149-184`).
- `zai/glm-5.2` only: user agent injected into the body ✓ (`builtins/gateway.zig:258-273`).
- **Rule violation:** message serialization uses `std.heap.c_allocator` as scratch ✓ (`gateway_json.zig:322,330,332`), contrary to `AGENTS.md` ("Never use a global allocator").

### Dead legacy path

`client.postGatewayCompletion` (`client.zig:610-676`, non-streaming) and `gateway_json.parseGatewayCompletion` (`gateway_json.zig:762-842`, OpenAI `choices[0].message.tool_calls`) have only test callers ✓. `builtins/gateway.zig` `fetchModelIds*` / `fetchPickerModel*` (1949-1995) are test-only public functions.

## 3. Streaming

- Reader `SseEventReader` (`client.zig:2619-2679`): `\n`-delimited, 256 KiB transfer buffer (:183), long lines accumulated up to 32 MiB (:188) else `error.GatewaySseEventTooLarge`; `error.GatewaySseReadStalled`; comments and blank lines ignored; `[DONE]` is framing only. Malformed JSON lines are skipped and traced (:2826-2830). Host reader: 16 KiB buffer, 1 MiB error-body cap.
- Event handling (`consumeSseStreamTraced`, :2751-3264):

| Event | Handling |
| --- | --- |
| any | `providerMetadata.gateway.generationId` captured and checked for consistency (`captureGenerationMetadata`, :2681) |
| `response-metadata` | strict `timestamp`, `modelId` ≤128 bytes; conflicts set `generation_metadata_invalid` |
| `error` | `captureProviderFailureDetail` (:2309), clipped to 600 bytes |
| `text-delta` | appended (bounded by `content_capture_limit`; the callback still receives the full delta) |
| `reasoning-delta` | callback only; **not retained** in the completion |
| `tool-input-start/delta/end` | streamed input records keyed by id; anomalies traced, not fatal (`StreamStateAnomaly`, :1954) |
| `tool-call` | authoritative final call (:2955-3101): string/object/array input normalized; absent input falls back to the exact-id ended stream; changed ids reconciled only through structurally equal ended input (`provisional_id`); conflicting names rejected; `providerExecuted` provenance or advertised provider-tool name |
| `tool-result` | only for provider-executed calls; preliminary vs final; failures recorded as `ProviderResultIdentityFailure` (`types.zig:579`, 13 cases) |
| `finish` | `finishReason.unified` must be one of `stop, length, content-filter, tool-calls, error, other` else `error.InvalidProviderFinishReason`; usage and billing parsed; **returns immediately** |
| ignored | `text-start/end`, `reasoning-start/end`, `source`, `file`, `raw`, `start`, `start-step`, `finish-step` |

- Terminal causes (traced by `traceSseTermination`): `valid_finish`, `done_without_finish`, `eof_without_finish`, `read_failure`, `cancellation`, `invalid_finish`. A partial result without finish is returned with `finish_reason = null` (test at :5363).
- `classifyProviderCompletion` (`types.zig:1139`): null finish → interrupted; `error`/`content-filter` → provider_failure; `length` → length_limited; tool calls with `stop`/`other` → invalid_completion unless all provider-executed. `authoritativeToolAdmission` (:1264) enforces identity, duplicate and argument rules.
- Callbacks fire synchronously on the calling thread in event order (test `direct gateway core callbacks stay on the invoking thread`, :7209). **There is no backpressure**: callbacks return void. Memory is bounded only by the line cap and `content_capture_limit`.

## 4. Usage, metadata, billing

- `finish.usage.{inputTokens,outputTokens}.total` → `types.Usage` (`parseSseUsage`, :2467).
- `GatewayBilling` requires `response-metadata.timestamp`, full token breakdown, `providerMetadata.gateway.cost` and `routing.canonicalSlug`, else billing is silently dropped (:2488-2580, 3217-3229).
- `generation_id` must be `gen_` + 26 Crockford base32 (`validGatewayGenerationId`, `types.zig:1067`).
- Session accounting (`session_usage.GatewayObservation`, `session_usage.zig:88-180`) classifies `observed_generation / possibly_billed_without_identity / ambiguous_delivery / unbilled`, then reconciles later via `GET {origin}/v1/generation?id=` (`client.zig:253-344`), allowed only for `https://ai-gateway.vercel.sh` or loopback (`isTrustedGenerationOrigin`, :605), 30 s bound, 128 KiB body cap; status policy in `generation_usage.zig:58`.
- Credits: `GET /coding-agent/v1/credits` (`builtins/gateway.zig:43`, 494-532). API key validation: `GET /coding-agent/v1/models` (645-664).

## 5. Errors

- Transport retryable: `HttpConnectionClosing`, `ConnectionResetByPeer`, `ConnectionTimedOut` (`isRetryableGatewayError`, `client.zig:10`), plus TLS init during setup (:724).
- Agent network evidence (`networkFailureEvidence`, :16-47): `SystemResumed` → `system_resumed`; TLS, setup timeout, DNS, refused/unreachable, `Timeout`, `WouldBlock`, `WriteFailed`, `ReadFailed` → `transport_interrupted`; everything else (OOM, `JsHostStreamFailed`, configuration) → no evidence, so the loop stops.
- fx-defined errors include `Cancelled`, `SystemResumed`, `ConnectionSetupTimedOut`, `Timeout`, `InvalidE2EGatewayUrl`, `GatewaySseEventTooLarge`, `GatewaySseReadStalled`, `InvalidProviderFinishReason`, `ReadFailed`, `HostStreamFailed`, `InvalidGatewayHistory`, `InvalidStructuredResponseSchema`, `MissingStructuredResponseFormat`, `StructuredResponseRequiresVerifiedImages`, `VisionToolNotRegistered`, `InvalidGenerationId`, `GatewayGenerationResponseTooLarge`, `AgentStreamProviderUnavailable`. **All flow as `anyerror`.**
- HTTP non-200 (`client.zig:1324-1358`): whole error body read **without a size cap** on the native path; ≥500 sets `delivery_ambiguous`; integer `retry-after` parsed (:1830), HTTP-date ignored.
- Diagnostics: `gateway_failure_diagnostics.collect` produces `failure_schema` and a redacted `failure_request_shape` (`gateway_json.formatGatewayRequestShapeSummary`, :635).
- Agent recovery policy (`model_response_recovery.zig`): pure `decide()` (:110-160) over `FailureCause`, `Delivery`, `ToolEvidence`; strategies `retry_request, continue_response, regenerate_tool, continue_after_confirmed_tool, reconcile_tool, pause, stop`; 10-attempt budget (:3); retry-after capped at 30 s (:4); backoff 250 ms, 1 s, doubling to 30 s (:163-174). The orchestrator adds one forced credential refresh on 401 for fx login only (3417-3441), a vision prefill repair (3443-3475), and status-based retry for 429/500/502/503/504 (`isRetryableModelStatus`, 1259).

## 6. Cancellation and deadlines

- `cancel_flag` (atomic bool) polled at every stage of `streamGatewayCompletionCoreWithOptions` (1156-1456) and per SSE event (:2797).
- `GatewayCancelWatcher` thread (1690-1717) polls every 10 ms and shuts the socket down; it also detects system suspend from the boot-vs-awake clock gap (>100 ms, `suspendGapDetected`, :1734). If the watcher cannot spawn, the request fails (test at :7166).
- Connection setup races `client.request` against cancel and a 30 s epoch deadline (`openGatewayRequestBounded`, 788-879); retries only while `definitely_unsent` (`decideConnectionSetup`, :707).
- `runBoundedHttpOperation` (1583-1678) races an operation against cancel and an absolute deadline; used by web search, permission review (15 s), generation lookup (30 s) and OAuth (15 s).
- The main agent stream has **no overall deadline**, only setup timeout plus cancel.

## 7. Model discovery

- `GET {base}/coding-agent/v1/models` (`builtins/gateway.zig:42,46,2151`); fx login uses `?teamId=`, keys use the team header (2094-2105); on 401/403 one anonymous retry (`fetchWithPublicFallback`, `model_catalog.zig:169-217`).
- Parse: `data[]` with `type == "language"`, tags, reasoning options, fast options, context window, max tokens, web-search pricing (2350-2447). Picker curation by hard-coded featured families (`model_catalog.zig:412+`).
- Capabilities = catalog metadata merged with local prefix heuristics, including a hard-coded 1M-context Anthropic table (`model_capabilities.zig:149-184`).
- In-memory caching only (`model_cache_runtime.zig:262+`, background warmup thread; `resolveForRequest` spins at 1 ms while loading).
- Defaults: `default_model = "zai/glm-5.2"` (`builtins/gateway.zig:40`), image model `google/gemini-2.5-flash`, reviewer model `zai/glm-5.2` (`auto_classifier.zig:15`).

## 8. Routing, fallback, retries

- Transport-owned attempts (image, web search, reviewer, bounded calls): up to `retry_count` = 3; 429/5xx retried with `retry-after` capped at 5 s, else 150 ms × attempt (`client.zig:1814-1822`).
- Agent-owned attempts: transport `retry_count` forced to 1 (`client.zig:1169-1172`); retries via `model_response_recovery` with the durable checkpointed budget.
- **No model fallback exists.** The only route change is disabling Fast after a replay-safe `provider_unavailable` (`shouldDisableFastRoute`, `model_response_recovery.zig:179`). Routing is entirely server-side in the Gateway (`providerMetadata.gateway.routing.canonicalSlug`, resolved-model headers only traced, `client.zig:1893`).

This matters for the rebuild: FX does not currently own any routing logic that must be "removed"; it owns a retry policy, a model catalog and credential handling, which move.

## 9. Web search

Provider-executed through the Gateway: `web_search_runtime.zig:246` → `builtins/gateway.zig:692` `executeWebSearchProvider` → `executeGatewayWorker` (798-867), a `"required"`-tool request with one provider tool (`gateway.perplexity_search` or `gateway.parallel_search`) posted to the same chat endpoint with the selected chat model. Results normalized from the provider `tool-result` (`normalizeGatewayCompletion`, 942-1053). `src/gateway/web_search*.zig` are 6-line re-exports.

## 10. Tests on this path

| File | Tests | Covers |
| --- | ---: | --- |
| `src/gateway/client.zig` | 120 | SSE finish/billing/identity/integrity, provider results, buffer boundary, 32 MiB cap, allocation failure, connection-setup policy, delivery certainty, agent vs transport attempts, loopback TLS/send/head/body stall cancellation and deadline, suspend gap, headers |
| `src/core/gateway/gateway_json.zig` | 35 | serialization, caching, structured format, history validation, legacy parser |
| `src/builtins/gateway.zig` | 54 | request builder, web-search worker, credits, catalog parsing |
| `src/core/agent/runtime/tests/gateway_flow.zig` | 139 | retry, recovery, Fast fallback, 401 refresh, vision, cancellation |
| `src/core/agent/runtime/model_response_recovery.zig` | 9 | pure policy |
| `src/gateway/generation_usage.zig` | 7 | including fuzz |
| `src/core/gateway/{gateway_provider,model_catalog,model_catalog_metadata}.zig` | 7 / 7 / 1 | |
| `src/gateway/host_stream_provider.zig` | 3 | error-body bound, pulse throttling |
| `src/core/agent/stream_provider.zig` | 1 | ordered callbacks |
| E2E | `gateway-stream-lifecycle.test.ts`, `tui-gateway-stream-lifecycle.test.ts`, `vision-route-fake-gateway.test.ts`, `web-search-fake-gateway.test.ts`, `session-recovery.test.ts`, `tui-interrupt-recovery.test.ts`, `tui-cost.test.ts`, `permission-errors.test.ts` | deterministic fake gateway |

Untested or weak:
- `js_host_stream_provider.zig`, `js_host_model_catalog.zig`, `gateway_failure_diagnostics.zig`: zero tests.
- `host_stream_provider.stream` itself (200 path, cancel −2, open failure) and its gaps.
- Uncapped native error body; HTTP-date `retry-after`; `content_capture_limit` truncation with full-delta callbacks; `reasoning-delta` not retained; billing dropped without `timestamp` (trace-only coverage).
- `image_provider.inspect` does not free its stream result unless the allocator is an arena (possible leak; INVESTIGATE).
- `retry_count == 0` on the native transport returns `error.HttpConnectionClosing` with no attempt.
- `c_allocator` scratch makes allocation-failure tests incomplete for message serialization.
