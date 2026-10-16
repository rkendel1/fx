# Host bridge (R4)

R4 connects the Rust FX executor to real Easy-LLM providers. The path from a caller to a provider response is one runtime with separate modules, and the executor stays the only authority on the outcome.

```text
Caller
  |  FX request document (bytes)
  v
host/node  createFxRuntime().execute(request, { provider })            JavaScript, schedules and translates
  |
  v
rust/fx-host  Session (WebAssembly)                                     owns the attempt
  |   decode + validate               fx_core::parse_request
  |   one attempt                     fx_core::Execution::step
  |   capability                      fx_single_attempt::SingleAttemptCapability
  |   provider port                   host-fed, no I/O
  v
host/node  Easy-LLM generateOnce / streamOnce                           one explicit provider, one call
  |
  v
Easy-LLM provider adapter  ->  provider HTTP endpoint
  |
  v
FX report: outcome, proposal checks, disposition, diagnostics
```

The diagram is the logical flow, not a requirement for separate products. Nothing here routes, retries, falls back, selects a model or executes a tool.

## Modules and ownership

| Module | Where | Owns | Does not own |
| --- | --- | --- | --- |
| Contract, validation, executor | `rust/fx-core` | request decoding and validation, event normalization, bounds, delivery certainty, proposal checks, the one terminal outcome, the report encoding | any provider, I/O, clock or host type |
| Provider port and adapter | `rust/fx-single-attempt` | translating provider observations to `Capability` values; refusing requests the provider path cannot carry | the state machine, the contract |
| Host session and WebAssembly ABI | `rust/fx-host` | the message protocol that lets a host that cannot block drive an attempt; the only raw-pointer code | any provider access, any import |
| Node host | `host/node` | loading the module, invoking one provider through Easy-LLM, feeding results back, cancellation plumbing | validation, normalization, retries, routing, credentials |
| Providers | `rkendel1/llm` | one provider call per `generateOnce` / `streamOnce`; credentials; transport | FX semantics |

Chip (agent loop, turn recovery, tool authorization) is not part of this path. It will consume FX through the report (R5).

## Deployment profile

- **Supported now:** Node.js 22 or later, running `rust/fx-host`'s `wasm32-unknown-unknown` build, with Easy-LLM providers in the same process. One entry point:

  ```js
  import { createFxRuntime } from "fx-host-node";
  const fx = await createFxRuntime({ wasm, easyLlm });
  const { report } = await fx.execute(requestDocument, { provider, mode: "stream", signal });
  ```

  `provider` is required and explicit (an Easy-LLM provider object, or the id of a provider you registered). `mode` selects `streamOnce` or `generateOnce` and is fixed before the call. Provider construction and credentials stay with the caller and Easy-LLM. See `host/node/README.md`.
- **Other WebAssembly hosts:** the module has no imports and speaks a documented protocol, so any host that can call exports and run a provider can drive it. Only the Node host exists and is tested. No browser host was written or run.
- **Not provided:** an N-API addon (the brief did not call for a second binding technology; the WebAssembly module serves Node and keeps one code path), a native Rust provider (Easy-LLM is TypeScript), consumer migration.

## The host protocol

All calls take and return bytes. The ABI (`rust/fx-host/src/abi.rs`, version 1) has ten exports: `fx_abi_version`, `fx_protocol_version`, `fx_alloc`, `fx_free`, `fx_session_new`, `fx_session_free`, `fx_begin`, `fx_command`, `fx_output_ptr` and `memory`. `fx_begin` takes the exact FX request bytes (strict decoding depends on them); `fx_command` takes a JSON command. Each returns the length of a JSON response held until the next call. The module imports nothing; the Node host refuses a module that asks for any import.

| Host sends | Meaning | Session answers |
| --- | --- | --- |
| `begin` (request bytes) | decode and validate; check the provider path can carry the request | `need_invoke` with the canonical request and the budget, or `done` (invalid request, unsupported feature: the provider is never invoked) |
| `invoke_result` ok or failure | the host invoked the provider, or learned it could not | `ready` |
| `step` | run the executor until it needs input or ends | `need_input` with the events forwarded so far, or `done` with the report |
| `feed` (items, observed delivery, ended) | provider output | `ok` |
| `feed_failure` | a provider failure | `ok` |
| `cancel` (transport closed?) | the caller cancelled | `ok`; honored at the next `step` |

A command after the attempt ended is answered `done` with `ignored: true`; nothing is replayed. Protocol misuse answers `error` with a fixed message that never echoes the command.

The earlier sketch in RUST_PRIMITIVES §10 (`fx_create`, `fx_push_event`, `fx_poll`, ...) is superseded by this message protocol: one entry point per direction keeps the ABI small and versionable, and the command set can grow without new exports.

## Why a resumable executor

A WebAssembly module cannot wait for a network read. `fx_core::execute` loops until the attempt ends, so it cannot be called while provider data arrives from the host's event loop. R4 adds `fx_core::Execution`, the same state machine as a type with `step` and `cancel`; `execute` is now a thin loop over it. The existing 47 executor tests and 22 fixtures pass unchanged, and `tests/execution_steps.rs` checks that stepping gives the same report, events and capability call counts as `execute` for six scenarios. Both paths share one implementation.

## Invariants and where each is enforced

| Invariant | Enforced by | Test |
| --- | --- | --- |
| Invalid request rejected before any provider call | `fx_core::parse_request` inside `Session::begin`; the host is told `need_invoke` only afterwards | `invalid_request_is_never_invoked`, `undecodable_document_is_never_invoked` (native and WebAssembly), bridge: provider call counts stay 0 |
| Unsupported request features fail before dispatch | `first_unsupported` before `need_invoke`, so the host is never asked to invoke | `unsupported_feature_is_refused_before_dispatch`; bridge test over five feature kinds in both modes; real adapter: zero HTTP requests |
| The capability is started once | `Execution` has one `start` call | diagnostics `starts == 1` in every fixture |
| Exactly one provider call, no retry, no fallback | the host calls `generateOnce` or `streamOnce` once; the executor never restarts | bridge: provider and backup call counts; real adapter: one HTTP request per attempt after a 429 |
| Delivery certainty never decreases | `DeliveryCertainty::advance`; the adapter raises errors to what was observed | `delivery_never_decreases`; `the_adapter_raises_an_error_to_the_delivery_it_already_observed` |
| Cancellation never claims the request was unsent after the provider was invoked | `SessionHost::cancel_requested`: before start, a cancel only counts if the host has not invoked the provider; the host defers a cancel until it knows whether the call was made | `cancel_after_invocation_is_never_reported_as_unsent`; bridge: cancel while awaiting the first event |
| No success is manufactured for an incomplete or unverified stream | an unverified `done` without a finish reason produces no `Finish`; an ended stream without `Finish` is an interrupted attempt | `unverified_done_without_a_reason_is_interrupted`; real adapter: truncated stream |
| No events after the terminal state | `Execution` returns `Finished` after the report; the session drops late feeds | `chunks_and_cancels_after_the_end_are_ignored`, `no_event_is_forwarded_after_the_report` |
| Tool proposals are data | the port carries no tool handlers; proposals are `Event::ToolCall` values; tool definitions are refused today | `tool_calls_are_data_never_executed` |
| No ambient authority | the module imports nothing; `check-boundaries.sh` forbids I/O, clocks, threads, async, env and global mutable state; unsafe code only in `abi.rs` under `cfg(wasm32)`; `host/node` lint forbids env, process, network and `eval` | bridge: `the module has no imports`, `a module that asks for host imports is refused`; boundary gates |

## Delivery and cancellation: what is true

- Delivery follows Easy-LLM's observations: `not_invoked` (the provider's call was never made) is the only state mapped to `definitely_unsent`; any call that was made is at least `possibly_sent`; a received chunk is `confirmed_response`.
- Cancel before the host invokes the provider ends as `Cancelled { definitely_unsent, not_started }`. Cancel after: the delivery observed so far, `remote: unconfirmed`, partial output kept.
- `remote: confirmed` is never produced by the Node host. Easy-LLM can pass the abort to `fetch` but cannot observe the transport closing. The protocol supports `transport_closed: true` for a host that can, and the native fixtures exercise it. Even `confirmed` does not mean the operation did not run.
- Cancellation needs the provider layer to return. Easy-LLM's single-attempt call returns promptly on abort or timeout even if a provider ignores the signal, and the result says `abortForwarded: false`; a provider that ignores the signal can keep running in the background.
- The executor observes a cancel only between steps; it cannot interrupt a provider call. The attempt budget is enforced by Easy-LLM (`timeoutMs`), not by the Rust core, which has no clock.
- The bridge waits for the first provider event before reporting the invocation, so time to first token is unchanged but the FX attempt begins then.

## Single physical attempt: what is and is not guaranteed

FX invokes the supplied capability once. For physical network attempts, the guarantee is only as strong as the provider:

- The built-in Easy-LLM adapters use `fetch` directly (no SDK) and do not retry; this is checked by tests that count HTTP requests after a 429 and after a reset (OpenAI adapter, real requests to the local mock). The other four adapters were read, not exercised here.
- A custom provider may retry internally. It reports `transportRetries: "unknown"` unless it declares `attemptTraits`, and the result carries that in `host.transportRetries`.
- `fetch` can follow redirects and the platform can retry on connection reuse; neither is controlled here.

## Provider coverage

| Provider | `generate` text | `stream` text | Notes |
| --- | --- | --- | --- |
| OpenAI (exercised end to end against a local mock) | yes | yes | stream completes only because the adapter now passes the provider's `finish_reason`; terminal stays `unverified` |
| OpenRouter | audit only | audit only | same code path as OpenAI; not exercised |
| Anthropic | audit only | completes as finish reason `other` | stream has no finish reason; `done` follows `message_stop` |
| Google | audit only | **every stream ends interrupted** | the adapter synthesizes `done` and reports no finish reason; use `generate` |
| Ollama | audit only | completes as `other` | `done` follows the server's `done: true` |

Unsupported for every provider today (refused before dispatch): images, tool definitions, tool-call history, tool choice, generation options, structured output, provider-executed tools. Streamed tool calls are unavailable from every built-in adapter. These are gaps in the provider layer (SINGLE_ATTEMPT.md "Gaps"), not in FX. Provider errors carry an HTTP status and `Retry-After` only when a response was received (rkendel1/llm#14); otherwise the kind is `transport`.

## Native and WebAssembly

| | Native Rust | WebAssembly (Node host) |
| --- | --- | --- |
| Code | `fx_host::Session` linked directly | the same `Session` behind `abi.rs` |
| Provider | none in production; tests feed scripted transcripts | Easy-LLM providers in the host |
| Conformance | `rust/fx-host/tests/conformance.rs` | `host/node/test/conformance.test.mjs`, same 26 fixture files |
| Equivalence | CI records the native responses; the WebAssembly run must produce identical responses for every shared fixture | |
| Differences | panics unwind the test, not an instance | a panic traps the instance; discard it. Memory is the instance's own and grows on demand. Sessions in one instance share memory but no state. |

Outcomes do not differ: no fixture is restricted to one target, and all 26 run on both.

## Security

- The host protocol bounds a command at 64 MiB; the executor separately bounds every event, collection and the whole attempt.
- Provider text that reaches an outcome passes through `fx_core::Detail`, which masks secret-shaped tokens and bounds the length. Diagnostics hold ids, counts and enums only. Tests plant a secret in the prompt, the affinity key and a provider error and check the whole result.
- Credentials never enter the FX request, the module or the report. The host package never reads the environment; examples read it explicitly.
- The module's memory is its own. A bad pointer from a host can corrupt only that instance.

## Running it

```bash
cd host/node
npm ci                       # installs Easy-LLM from a pinned git ref
npm run build:wasm
npm test                     # 71 tests, offline
npm run example:mock         # real OpenAI adapter -> local mock endpoint -> FX outcome
```

Optional live smoke test (never run by CI; spends tokens):

```bash
FX_LIVE_SMOKE=1 OPENAI_API_KEY=... FX_LIVE_MODEL=... npm run example:live
```

## Not production ready

R4 makes the path work and testable; it is not the R6 readiness review. Open items:

- The Easy-LLM dependency is a pinned git ref because the published `0.10.1` predates `generateOnce`. Switch to the registry when a release includes it.
- Only the OpenAI adapter has run end to end, and only against a mock. No live provider run is part of CI.
- Tool-using requests cannot run until the provider layer carries tool schemas and tool-call history.
- No fuzzing of the ABI, no performance measurement, no load or memory-ceiling testing of the module.
- No N-API, browser or non-Node host.
- `remote: confirmed` cannot be produced by the Node host.
