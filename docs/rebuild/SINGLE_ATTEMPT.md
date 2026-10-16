# Single-attempt provider invocation (R3)

R3 connects the FX capability boundary to a provider layer without moving any FX responsibility into it. This document records what the provider layer (Easy-LLM, `rkendel1/llm`) actually does today, what a lifecycle owner needs from it, and how `rust/fx-single-attempt` translates between the two. The Rust crate is the deliverable in this repository; the provider-side TypeScript operation it mirrors is proposed separately in [rkendel1/llm#13](https://github.com/rkendel1/llm/pull/13) (a draft, not merged at the time of writing).

## Ownership

| Concern | Owner |
| --- | --- |
| Select a model and provider for normal application use | Easy-LLM routing (`llm()`) |
| Invoke an explicitly selected provider once | Easy-LLM single-attempt operation |
| Validate the inference contract, normalize events, enforce attempt invariants, produce the one outcome | FX (`fx-core`) |
| Translate provider observations into FX values | `fx-single-attempt` (this repository) |
| Decide whether to retry an agent turn | Chip |
| Authorize and execute application tools | Chip and the applicable authority boundary |

The adapter owns no state machine and defines no contract type. Delivery certainty, failure origin, events and outcomes are `fx-core`'s. If this document and `fx-core` disagree, `fx-core` wins.

## What the provider layer does today

Read from `rkendel1/llm` `main` at `9ca9e9e` (package 0.10.1), all five built-in adapters in full. The evidence for each row is the source; the llm draft PR adds tests that check the retry and cancellation rows against a stubbed `fetch`.

**The routed path (`llm()`, `llm.stream()`) is not a single attempt.** It initializes default providers (reading credentials and environment), refreshes and consults the model registry, resolves routing preferences, falls back across providers and routes on retryable errors, records routing observations, and runs application tool handlers followed by another provider call (up to `maxToolRounds`). On a timeout or abort it stops waiting but the provider promise keeps running.

**Direct provider invocation (`provider.generate` / `provider.stream`):**

| Question | Finding |
| --- | --- |
| SDK or HTTP client | None. Each client calls the global `fetch`; the package has no runtime dependencies. |
| Hidden retries in one call | None. One `fetch` per call. A `withRetry` helper exists but no adapter uses it. |
| Hidden fallback or routing in an adapter | None. `supports()` is a routing helper, not part of a call. |
| Tool handlers run by an adapter | No. Adapters send tool names with empty schemas. Only the routed runtime calls handlers. |
| `request.signal` honored | No: no adapter passed it to `fetch`, so a timeout left the HTTP request running. |
| Errors | Flattened to message text. HTTP status, `retry-after` and body are lost; `retryable` is guessed from text. |
| Finish reason | Dropped by every adapter. |
| Usage | Returned by `generate` for most adapters; never by `stream`. |
| Malformed tool arguments | OpenAI-style adapters `JSON.parse` and throw, losing the raw text. Anthropic and Google invent ids when absent. |

**Streaming:**

| Provider | `done` is emitted | Streamed tool calls |
| --- | --- | --- |
| openai, openrouter | after the read loop ends, whether or not `[DONE]` was seen | placeholder (`id: "tool-call-1"`, `name: "unknown"`) |
| google | after the read loop ends, unconditionally | dropped |
| anthropic | only on `message_stop` | dropped |
| ollama | only when the server sends `done: true` | not supported |

So a truncated OpenAI-style or Google stream looks complete at this layer, and no built-in adapter streams tool calls faithfully. The port reports this as `Terminal::Unverified` and refuses to offer tools to such a provider on the streaming path.

## What FX needs from the provider layer

One call per attempt, with these facts reported and never invented:

1. **Delivery as observed.** `NotInvoked` (the provider's call was never made; the only proof of "unsent"), `Invoked` (possibly sent; never downgraded after an error, timeout or abort), `OutputObserved` (a chunk or response arrived).
2. **Output as data.** Text, tool-call proposals (id, name, arguments as JSON text when they serialize), usage and the provider's own finish reason, verbatim.
3. **A terminal that means something.** `done` backed by the provider's own marker, or flagged unverified.
4. **Typed failures** that preserve the observation, the HTTP status and retry-after when the layer can supply them.
5. **Abortable calls**, with an honest report of whether the transport closed.

## Port to capability mapping

`ProviderPort` (`rust/fx-single-attempt/src/port.rs`) mirrors those facts. The host bridge (R4) implements it over the TypeScript operation.

| Capability call | Adapter behavior |
| --- | --- |
| `start` | Refuses a request the port cannot carry (below) with `CapabilityUnavailable` and `DefinitelyUnsent`, without calling the port. Otherwise calls `invoke` once and reports `PossiblySent`, because the provider call is made inside `invoke`. |
| `poll` | Asks the port for up to `max_events` items, expands them into FX events, and returns at most `max_events`. Extra events from one item (a `Done` yields metadata, usage and finish) are queued for later polls. Nothing after the provider's `done` is read. |
| `cancel` | Calls `abort`. `Confirmed` only if the port saw the transport close; otherwise `Requested`. Either way FX keeps `may_have_executed` for any delivery beyond `DefinitelyUnsent`. |
| `close` | Calls `release` once. |

**Items to events:** `Text`→`TextDelta`; `ToolCall`→`ToolCall` (absent arguments become the empty string, which FX records as missing and `admit_proposals` refuses; the adapter never repairs); `Done`→`Metadata` (if a model is reported), `Usage` (if any field is reported), then `Finish`.

**Finish.** A provider finish reason maps by exact match (`stop`, `end_turn`, `stop_sequence`, `STOP`→Stop; `length`, `max_tokens`, `MAX_TOKENS`→Length; `tool_calls`, `tool_use`→ToolCalls; `content_filter`, `SAFETY`→ContentFilter; `error`→ProviderError); anything else is `Other`. With no reason: a provider-marker `done` is `Other` (completion was proven), an unverified `done` emits **no `Finish`**, so FX reports an interrupted attempt with the partial output (invariant I3) instead of a success.

**Failures:**

| Port failure | `ErrorKind` |
| --- | --- |
| ProviderNotFound, Unsupported | CapabilityUnavailable |
| InvalidRequest | InvalidRequest |
| Aborted | Cancelled |
| Timeout | Timeout |
| MalformedOutput | ProtocolViolation |
| IncompleteStream | the batch ends with no `Finish`; FX produces `Failed { Executor, Transport, partial }` |
| ProviderError, status 401 / 403 / 404 / 429 / 5xx | Unauthenticated / Forbidden / ModelUnavailable / RateLimited / ProviderUnavailable |
| ProviderError, no status or another status | Transport (never guessed from message text) |

Delivery maps `NotInvoked`→`DefinitelyUnsent`, `Invoked`→`PossiblySent`, `OutputObserved`→`ConfirmedResponse`, and an error is raised to at least the delivery already observed. Provider text becomes a `Detail`, which FX masks and bounds. Queued events are delivered before a stored poll failure is reported.

**Request features the port cannot carry** are refused up front, naming only the feature: image parts, tool-call history, tool definitions with schemas, provider-executed tools, tool choice other than `Auto`, generation options (max tokens, reasoning, speed) and structured output. Cache hints are advisory and are not refused. A port declares what it carries through `PortSupport`; today's Easy-LLM types carry none of the list except images (OpenAI and OpenRouter), so a real bridge would refuse most tool-using requests until the provider types grow.

## Gaps and the smallest change for each

| Gap | Effect | Smallest change (provider layer) |
| --- | --- | --- |
| Errors carry no HTTP status or retry-after | `ProviderError` always maps to `Transport` | optional `status` and `retryAfterMs` on `ProviderError`, set from the response |
| No tool schemas are sent | tool use is refused | optional tool definitions with JSON schemas on the request |
| No assistant tool-call history | multi-turn tool conversations are refused | `toolCalls` on assistant messages |
| Raw tool-argument text lost on malformed JSON | the whole call fails as a provider error | keep the raw text instead of throwing |
| Streams report no usage or finish reason; `done` is synthesized for three providers | streamed answers from them are `Unverified` | populate usage and finish on `done`; emit `done` only after the provider's marker |
| No generation options transported | requests with them are refused | forward them |
| No provider-executed tool records | none are produced | out of scope until a provider supports it |

None of these is worked around in FX.

## Tests

`rust/fx-single-attempt/tests/adapter.rs` runs the real `fx_core::execute` over a scripted port. See BEHAVIOR_MATRIX §10 for the map. Everything is offline and deterministic.

## Not in R3

The Node and WASM bridge that implements `ProviderPort` over the TypeScript operation, the shared-fixture run through it, and the wire encoding of `ExecutionReport` are R4. No consumer is migrated.
