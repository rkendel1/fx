# Native Rust providers behind the single-attempt port

`rust/fx-native-provider` lets a native Rust host run FX inference without a Node process, a JavaScript runtime or a second execution path. It implements FX's existing `ProviderPort` ([SINGLE_ATTEMPT.md](SINGLE_ATTEMPT.md)) over an HTTP client. Everything else is unchanged: `fx-core` validates and normalizes, `fx-single-attempt` maps the port's observations to FX events and the one terminal outcome, and the host drives it with `fx_core::execute`.

```
Request -> fx_core::execute -> SingleAttemptCapability<P: ProviderPort> -> P
                                                                     |-- Node host: Easy-LLM generateOnce/streamOnce (WebAssembly executor)
                                                                     `-- native host: fx-native-provider (this crate)
```

Both providers are `ProviderPort` implementations. Validation, support gating, delivery certainty, cancellation, event normalization and outcomes are the same code for both.

## Scope of this change

One provider: an OpenAI-compatible streaming chat-completions endpoint (`POST {base_url}/chat/completions`). It carries text conversations. Nothing else is claimed.

A second provider was not added. Anthropic and Google use different request bodies and stream formats, so each needs its own encoder and decoder. The transport (one worker thread, one request, a polled channel) would be shared, but it is not yet factored out of `provider.rs`, and splitting it for a second user that does not exist yet would add API for no consumer. The follow-up is to extract the worker when the second provider lands.

## Audit

### The contract

`ProviderPort` (`rust/fx-single-attempt/src/port.rs`) has five methods: `support`, `invoke`, `poll`, `abort`, `release`. It reports observations only.

| Port type | Meaning | Native use |
| --- | --- | --- |
| `Observed` (`NotInvoked`, `Invoked`, `OutputObserved`) | what is known about delivery | `Invoked` once the call starts; `OutputObserved` after the first stream chunk or a complete 2xx response |
| `PortFailure` (`kind`, `message`, `observed`, `status`, `retry_after`) | a failed call | status and `Retry-After` are carried, which the Node path also does |
| `PortItem` (`Text`, `ToolCall`, `Done`) | output | `Text` and `Done`; `ToolCall` is never produced |
| `Terminal` (`ProviderMarker`, `Unverified`) | whether the provider's own marker backs `done` | `ProviderMarker` only after `data: [DONE]` |
| `AbortReport` | whether the transport was seen closing | always `transport_closed: false` (see Cancellation) |
| `PortSupport` | features the port can carry | all false; the capability refuses everything else before `invoke` |

The Node path implements the same trait in the WebAssembly host. No FX type was added for the native provider and no public API in `fx-core` or `fx-single-attempt` changed.

### Easy-LLM adapters and what can be done in Rust

Easy-LLM (`@easy-llm/llm` 0.10.2) has five built-in adapters: OpenAI, OpenRouter, Anthropic, Google and Ollama. Each is plain HTTP with `fetch` and no vendor SDK, which is why none needs a JavaScript runtime. The feature support of each behind the FX path is in [PROVIDER_CONFORMANCE.md](PROVIDER_CONFORMANCE.md) (generated; mocked transport).

| Provider | Wire format | Direct in Rust | Status here |
| --- | --- | --- | --- |
| OpenAI and compatible gateways | SSE, chat completions | yes, with `ureq` and `serde_json` | implemented |
| OpenRouter | same as OpenAI | yes, same decoder with another base URL | works through the OpenAI-compatible config; not separately tested |
| Ollama | NDJSON `/api/generate` (its OpenAI-compatible `/v1` endpoint also works here) | yes | the `/v1` endpoint only; native NDJSON not implemented |
| Anthropic | SSE messages API with typed events | yes | not implemented |
| Google | JSON stream, no terminal marker | yes, but the stream cannot be verified complete | not implemented |

Libraries: `ureq` 3 (blocking HTTP) with `rustls` and bundled `webpki-roots`, and `serde_json` (already pinned in `fx-core`). No async runtime, no provider SDK, no OpenSSL. All were chosen because the rest of the FX graph is synchronous and blocking, and `ProviderPort` is a polled interface.

## Behavior

### One call

`invoke` validates the request, starts one worker thread, and returns. The worker makes exactly one `POST`, follows no redirects, ignores proxy environment variables, and streams the response into a channel. `poll` waits up to 25 ms on that channel and returns what arrived. There is no retry, no fallback, no routing and no second request; `check-boundaries.sh` enforces a single `.post(` site in the source.

The request body contains the model reference, role-tagged text messages, `stream: true` and `stream_options.include_usage: true`. The credential appears only in the `Authorization` header.

### Delivery certainty

| Situation | Reported by FX |
| --- | --- |
| Request refused by FX validation or the support gate | `definitely_unsent`; no connection is opened |
| Connection refused, DNS failure, closed without a response, HTTP error status | `possibly_sent` |
| Stream chunk received, then any failure | `confirmed_response`, partial text kept |
| Complete 2xx response with no terminal marker | `confirmed_response`, an interrupted attempt (executor failure) |
| Attempt budget elapsed with nothing received | `possibly_sent`, kind `timeout` |

A failure seen after `invoke` returned is never reported as `NotInvoked`, because a send can fail part-way and FX never lowers certainty once the call started. A refused connection is therefore `possibly_sent`. That is conservative and, as far as the contract goes, accurate: the port cannot prove nothing left the process. The Node path reports the same.

### Terminal handling

* `data: [DONE]` after a `finish_reason` completes the attempt (`ProviderMarker`). Anything after the marker is never read or forwarded.
* `[DONE]` without a finish reason is a protocol violation, not a completion.
* A stream that ends without the marker is an interrupted attempt with its partial text.
* A broken connection mid-stream is a transport failure with its partial text.
* Invalid UTF-8, invalid JSON, a non-object chunk and a non-event-stream 200 are protocol violations.
* A tool-call delta is a protocol violation: no tools were offered, so a proposal could not be legitimate. The attempt fails and nothing is surfaced.
* An `error` object in the stream is a provider failure; its message is redacted.
* Only choice index 0 is read.

### Refusal, usage, errors

* `delta.refusal` text is delivered as output text and the finish reason is reported as `content_filter`, so FX classifies the attempt as a refusal while the refusal text survives.
* Usage is reported when present: input, output, cached input and reasoning tokens. Absent fields stay unknown.
* The provider's finish reason is passed through verbatim; FX maps it.
* HTTP status and `Retry-After` (seconds) are preserved. The status decides the error kind (401 unauthenticated, 403 forbidden, 404 model unavailable, 429 rate limited, 5xx provider unavailable, other statuses transport), never the message text.
* The error message is the provider's `error.message` (or a bounded body prefix), with the credential removed here and `mask_secrets` applied again by FX. Error bodies are read up to 8 KiB.

### Cancellation and deadlines

* Cancel before dispatch: FX never calls `invoke`; no connection is opened.
* Cancel in flight: `abort` sets a flag and `poll` stops waiting, so FX returns promptly with partial text and remote cancellation `unconfirmed`. A blocking read cannot be interrupted from another thread, so the transport is not observed closing and `transport_closed` is `false`. The worker stops at its next read or at its deadline; it is detached and holds no FX state.
* Deadlines: the attempt budget bounds both the HTTP client (global timeout) and `poll` (which fails with `timeout` at the deadline even if the worker is blocked). Without a budget the deadline is `OpenAiConfig::DEFAULT_DEADLINE` (120 s), which also bounds how long an abandoned worker can live. The connect timeout is 10 s.

### Credentials

The host passes `OpenAiConfig::new(base_url, Secret)`. Nothing is read from the environment or files. `Secret` prints as `Secret([redacted])`. The credential is never placed in a request body, an event, an outcome, a diagnostic or a session log by this crate, and every provider-derived message has it removed. Configuration refuses plain `http` unless the host is loopback, refuses credentials, a query or a fragment in the URL, and refuses an empty key.

## Supported and unavailable features

| Feature | Native OpenAI-compatible | Node (Easy-LLM OpenAI adapter) |
| --- | --- | --- |
| Text conversations (system, user, assistant) | supported | supported |
| Streaming with provider-verified completion | supported | supported |
| Usage on a stream | supported (when the endpoint sends it) | unverified |
| Finish reason on a stream | supported | supported |
| HTTP status and `Retry-After` | supported | supported |
| Refusal text and `content_filter` finish | supported | finish only |
| Non-streaming generation | not offered | supported |
| Tool definitions, tool choice, tool-call history, provider tools | refused before dispatch | refused before dispatch |
| Images | refused before dispatch | refused before dispatch |
| Max output tokens, reasoning effort, speed | refused before dispatch | refused before dispatch |
| Structured output | refused before dispatch | refused before dispatch |
| Prompt cache hints | ignored | ignored |
| Proxies, custom CA certificates, mTLS | not supported (bundled public roots, no proxy) | uses the Node `fetch` environment |
| Remote cancellation confirmation | never confirmed (`unconfirmed`) | transport closing is observed |

"Refused before dispatch" is `ErrorKind::CapabilityUnavailable` with `definitely_unsent`, produced by the capability's support gate. The adapter has a second check that fails a tool message, a non-text part or a tool definition with `Unsupported` before any thread starts.

### Differences from the Node-backed path

Found by running the same scenarios through both paths (below). Three scenarios differ, each recorded in `host/node/conformance/native-parity.mjs`, which fails if a difference changes or disappears.

| Scenario | Node (Easy-LLM) | Native |
| --- | --- | --- |
| Unparseable line inside a stream | skipped; the attempt completes | protocol violation; text so far kept |
| Text after `[DONE]` | included in the output (recorded Easy-LLM limitation) | never read |
| Tool call although none was offered | surfaced as a proposal, then refused by FX | protocol violation; nothing surfaced |

Native is the stricter behavior in each. Closing the Node-side gaps belongs to Easy-LLM and is not part of this change.

## Conformance

### What this proves, and what it does not

All evidence here is **mocked transport**: a deterministic HTTP server on loopback, plain `http`, a fake credential, no external network. It proves how the adapter and FX behave for those bytes. It does **not** prove:

* anything about a live provider (no live request was made in this change; the wire format was written from the documented chat-completions stream and the Easy-LLM adapter's parsing);
* the TLS path (`https`, certificate validation, bundled roots): the library code is established but no test here exercises a handshake;
* behavior behind a proxy or with a corporate CA.

Live verification needs a real key and is out of scope for CI. To run one by hand, build `fx-native-provider` into a host, call `OpenAiConfig::new("https://api.openai.com/v1", Secret::new(key))` and execute one request; record the result separately from this document.

### Native conformance suite

`rust/fx-native-provider/tests/conformance.rs` runs 27 cases through the real `fx_core::execute` and `SingleAttemptCapability`:

* success normalization: text, usage, model, finish reason; length finish; missing usage stays unknown; refusal text with `content_filter`; events split across reads; CRLF framing;
* request shape: one POST, path, credential only in the header, `stream: true`, no tool surface;
* HTTP errors 400, 401, 403, 404, 429 (with `Retry-After`), 500, 503: mapped kind, status, retry-after, `possibly_sent`, one connection each (no retry); a 302 is a failure and the redirect target receives no connection;
* protocol failures: 200 that is not an event stream, in-stream error object, malformed JSON, `[DONE]` without a finish reason, an empty complete response, an unoffered tool call;
* unsupported shapes (image, tools, tool choice, max tokens, speed) and an invalid request are refused with zero connections;
* cancellation before dispatch (zero connections), in flight (prompt, partial text, `unconfirmed`), and while waiting for the response (`possibly_sent`);
* deadlines: a silent server and a stalled stream time out with the right delivery certainty;
* ambiguous delivery: a connection closed without a response and a refused connection are `possibly_sent`; a stream cut before its marker is `confirmed_response` with partial text;
* no hidden retry: every failure case asserts the server saw exactly one connection;
* credential redaction: a provider that echoes the key in an HTTP error body and in a stream error never leaks it into the report or events; the key is not printable from the configuration.

Run: `cd rust/fx-native-provider && cargo test --locked`.

### Node versus native parity

`host/node/conformance/native-parity.mjs` starts the Node suite's own OpenAI mock server and, for each of 26 scenarios, runs the request through the Node-backed path (Easy-LLM adapter in the WebAssembly executor) and through the native example `native_parity`. Both outcomes are in FX's wire encoding. The script compares outcome type, finish reason, text, usage counts, error kind, origin, delivery certainty, status, retry-after and partial text. Result: 23 identical, 3 documented differences (above), 0 undocumented.

Run:

```
cargo build --manifest-path rust/fx-native-provider/Cargo.toml --example native_parity
cd host/node && npm run build:wasm && npm run conformance:native
```

## Chip integration readiness

The surface a host needs is small and already enough for `chip-fx`:

```rust
let config = OpenAiConfig::new(base_url, Secret::new(api_key))?; // host-provided
let mut capability = SingleAttemptCapability::new(OpenAiCompatible::new(config));
let report = fx_core::execute(&mut capability, &request, &Limits::DEFAULT, &mut host);
```

Wiring `chip-fx` to this crate is a separate change in `rkendel1/chip-rs`. This change does not touch `chip-legacy-http` or the native `chip` binary, and the session-interop pin is unchanged. Before `chip-legacy-http` can be retired, the unavailable rows above that Chip needs (tool calling, options) must be addressed, and a live-provider check must be recorded.

## CI, licensing and platforms

* Workflow: `.github/workflows/native-provider.yml` runs fmt, Clippy with warnings denied, tests, a release build, the boundary script, the license script and the Node/native parity check on Linux and macOS.
* `check-boundaries.sh`: dependency allowlist, forbidden families (async runtimes, other HTTP stacks, OpenSSL, provider SDKs), exact manifest dependencies, source patterns (no environment, filesystem, processes, global state, async, retry or routing vocabulary), a single request site, and no Wasm-bound FX crate depending on this one.
* `check-licenses.py`: every crate in the graph on five native targets (Linux x86_64 and aarch64, macOS x86_64 and aarch64, Windows x86_64) has a permissive license. The graph has 38 crates: MIT, Apache-2.0, ISC, BSD-3-Clause, Unicode-3.0, Unlicense and CDLA-Permissive-2.0 (`webpki-roots`).
* Platforms: native only. The crate does not build for `wasm32-unknown-unknown` (checked: `getrandom`, pulled in by `ring` through `rustls`, has no backend there, and a Wasm module has no sockets anyway), so it is not part of the WebAssembly graph; `fx-core`, `fx-single-attempt` and `fx-host` do not depend on it, and their Wasm builds are unchanged. Windows is covered by the license graph but not built in CI.
* Dependency policy: `fx-core` and `fx-single-attempt` keep their I/O-free allowlists. This crate is the host-side exception for native transport and has its own allowlist ([ARCHITECTURE.md](ARCHITECTURE.md)).
