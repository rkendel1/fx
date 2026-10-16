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

- The built-in Easy-LLM adapters use `fetch` directly (no SDK) and do not retry; this is checked by tests that count HTTP requests after a 429 and after a reset (all five adapters, real requests to local mocks; the `single-invocation` and `http-error-single-attempt` conformance cases, see PROVIDER_CONFORMANCE.md).
- A custom provider may retry internally. It reports `transportRetries: "unknown"` unless it declares `attemptTraits`, and the result carries that in `host.transportRetries`.
- `fetch` can follow redirects and the platform can retry on connection reuse; neither is controlled here.

## Provider coverage

Provider support is determined by conformance evidence, not by what an adapter is meant to do. The full matrix, with the cases that back every entry, is [PROVIDER_CONFORMANCE.md](PROVIDER_CONFORMANCE.md) (generated; CI checks it is current). In short, through the real Rust executor against local mocks of each endpoint:

| Provider | `generate` text | `stream` text | Stream finish reason | Usage (`generate`) |
| --- | --- | --- | --- | --- |
| OpenAI | supported | supported | carried | supported |
| OpenRouter | supported | supported | carried | supported |
| Anthropic | supported | completes as finish `other` (the reason is not carried) | not carried | supported |
| Google | supported | **unsupported: every stream ends interrupted** (no terminal evidence is carried) | not carried | supported |
| Ollama | supported (needs the server's `done_reason`) | completes as `other` | not carried | not carried |

Every status is mock-backed. **No live provider has been run**, and a passing conformance run is not evidence that a live service sends the wire format the mock reproduces. Unsupported for every provider (refused before dispatch, as `definitely_unsent`): images, tool definitions, tool-call history, tool choice, generation options, structured output, provider-executed tools. Provider errors carry an HTTP status and `Retry-After` only when a response was received (rkendel1/llm#14); otherwise the kind is `transport`.

## Provider conformance (R5)

`host/node/conformance` runs the same cases against every Easy-LLM adapter. Each adapter is the real one, unmodified; only the endpoint is a local mock (`mock-providers.mjs`) that speaks that provider's wire format. A request names its scenario as the model, so one scenario means the same situation on all five endpoints (`scenarios.mjs`).

```bash
cd host/node
npm run build:wasm
npm run conformance          # prints results by provider and case; exits 1 on any failure
npm run conformance:check    # what CI runs: two runs must be identical; manifest and document must match
npm run conformance -- --provider google --case stream-success   # a subset (skips the manifest check)
```

- **Cases** (`cases.mjs`, 34): the twelve required behaviors (collected and streamed completion; empty streams; finish-reason mapping; stream and collected response without a verified finish; HTTP status and `Retry-After`; malformed responses; connection failure before and after invocation; cancellation and late events; missing and malformed usage; exactly one invocation) plus FX invariants over provider output and one refusal case per feature the path cannot carry. Behavior 8 "connection failure before a request is sent, where demonstrable": the only demonstrable cases are the ones refused before the provider is called (invalid and unsupported requests, a signal already aborted); a refused connection is `possibly_sent`, because `fetch` cannot show that no bytes left the host.
- **Invariants on every attempt**, checked after every run so a case cannot forget them: at most one provider request and one Easy-LLM invocation; delivery never `definitely_unsent` once a request was made; a completion only with a verified finish; at most one `finish`, last, and none on a non-completion; the credential absent from the whole FX result.
- **Result states**: `pass`; `limitation` (the assertions held and the case recorded a documented gap, so the manifest cannot call that feature `supported`); `fail`. A limitation is asserted, not assumed: if an adapter is fixed, the case fails until the expectation and the manifest are updated.
- **Manifest** (`manifest.json`, schema 1): sixteen features per provider, each `supported`, `unsupported` or `unverified`. It is descriptive evidence, not a second runtime contract. `npm run conformance` refuses a manifest that claims `supported` without a passing case or with a limitation recorded, `unsupported` with no case recording the gap, an `unverified` or `unsupported` entry without a note, a live claim, or an Easy-LLM commit other than the one `package.json` and the lockfile pin.
- **Determinism**: results contain no timings or timestamps; `--repeat 2` fails unless both runs are identical. Each case has a 20-second deadline, because a lost cancellation shows as a hang.
- **Mutation checks** (done once by hand, not in CI): dropping the HTTP status or `Retry-After`, lowering delivery, always marking a collected response as terminal, not forwarding the signal and calling the provider twice each made specific cases fail.

### Terminal-state rules this exposed or confirmed

- A successful end needs evidence. A streamed attempt completes only on a finish reason the provider supplied, or on the provider's own terminal marker (then finish `other`). An adapter-synthesized end with no reason is an interrupted attempt that keeps its partial output.
- **Corrected in this PR:** a collected response with no finish reason used to be reported as a completion with finish `other`, including a body that parsed but was not a response (`{}`). The host marked every collected result as terminal proof. It now does so only when the provider named a finish reason (`translate.js` `resultToEvents`); otherwise the attempt is interrupted, the same rule as a stream. Consequence: an Ollama server that omits `done_reason` on a non-streaming response yields an interrupted attempt.
- An unknown provider finish reason maps to `other`, never `stop`. `content_filter` / `SAFETY` map to `content_filter`; `refusal` (Anthropic) maps to `other`. A provider claiming `tool_calls` while returning none does not get a valid completion (the executor reports `invalid_completion`).
- Missing or invalid usage never invalidates a completion. A usage object with some invalid fields keeps the valid ones; fully invalid usage is dropped.

### What the suite found in Easy-LLM (not worked around here)

These need changes in `rkendel1/llm`; FX adds no compensation (`unsupported` in the manifest):

- **Google** stream: no finish reason, no usage, a `done` yielded unconditionally. Streaming completion cannot succeed. The wire format the adapter parses (one JSON object per line) is also unchecked against the live service, which by default sends a JSON array.
- **Anthropic and Ollama** streams end on the provider's marker but drop `stop_reason` / `done_reason` and usage, so every streamed completion reports finish `other`.
- **OpenAI and OpenRouter** streams keep reading after the provider's terminal marker, so text sent after `[DONE]` joins the output. Streamed usage is parsed if sent, but the request does not ask for it (no `stream_options`), so it is `unverified`.
- **Stream lines that fail to parse are skipped silently** by every adapter except Ollama (which fails the attempt). Text carried only by such a line is lost without a signal.
- **Ollama** does not read token counts from a collected response.

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
npm test                     # offline: bridge, fixtures, real-adapter and provider conformance tests
npm run conformance:check    # provider conformance, manifest and generated document
npm run example:mock         # real OpenAI adapter -> local mock endpoint -> FX outcome
```

Optional live smoke test (never run by CI; spends tokens):

```bash
FX_LIVE_SMOKE=1 OPENAI_API_KEY=... FX_LIVE_MODEL=... npm run example:live
```

## Not production ready

R4 made the path work and testable and R5 made provider support evidence-based; neither is the R6 readiness review. Open items:

- The Easy-LLM dependency is a pinned git commit on the merged `main` of rkendel1/llm (`336939a`, which includes #13 and #14) because the published `0.10.1` predates `generateOnce`. Switch to the registry when a release includes it.
- All five adapters have run end to end, but only against local mocks of their wire formats. No live provider run is part of CI, and none is recorded.
- Tool-using requests cannot run until the provider layer carries tool schemas and tool-call history.
- No fuzzing of the ABI, no performance measurement, no load or memory-ceiling testing of the module.
- No N-API, browser or non-Node host.
- `remote: confirmed` cannot be produced by the Node host.
