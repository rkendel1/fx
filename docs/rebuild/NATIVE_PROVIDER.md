# Native Rust providers behind the single-attempt port

`rust/fx-native-provider` lets a native Rust host run FX inference without a Node process, a JavaScript runtime or a second execution path. It implements FX's existing `ProviderPort` ([SINGLE_ATTEMPT.md](SINGLE_ATTEMPT.md)) over an HTTP client. Everything else is unchanged: `fx-core` validates and normalizes, `fx-single-attempt` maps the port's observations to FX events and the one terminal outcome, and the host drives it with `fx_core::execute`.

```
Request -> fx_core::execute -> SingleAttemptCapability<P: ProviderPort> -> P
                                                                     |-- Node host: Easy-LLM generateOnce/streamOnce (WebAssembly executor)
                                                                     `-- native host: fx-native-provider (this crate)
```

Both providers are `ProviderPort` implementations. Validation, support gating, delivery certainty, cancellation, event normalization and outcomes are the same code for both.

## Scope of this change

Two providers, chosen for the services Chip is actually run against (Anthropic, LM Studio, OpenRouter):

* `OpenAiCompatible`: an OpenAI-style streaming chat-completions endpoint (`POST {base_url}/chat/completions`). This is the wire format of OpenAI, **OpenRouter** and **LM Studio** (and Ollama's `/v1` endpoint), so one provider with different configuration serves all of them.
* `Anthropic`: the Messages API (`POST {base_url}/messages`).

Both carry text conversations, an output token cap and a sampling temperature. The OpenAI-compatible provider also carries a JSON-schema response format (structured output). Nothing else is claimed. They share one worker, one polling model, one set of delivery rules and one `Wire` seam (`wire.rs`): a provider is only its request, its headers and its stream decoder. Google and native Ollama are not implemented.

### What the provider does not do: choose

Easy-LLM's CLI keeps credentials in an encrypted vault (`~/.llm/credentials.enc`, unlocked with a master password) and its router picks the provider and model. Neither is part of this crate, deliberately:

* **No router.** FX never selects or falls back (routing is out of scope for the executor). The host passes an explicit provider kind, endpoint and model. A user who relies on Easy-LLM's router keeps the Node-backed path; a native host needs its own explicit selection (Chip already has one: `--provider`, `--model`, `--endpoint`).
* **No vault.** Credentials are passed in by the host as a `Secret`; this crate reads no environment and no file, and does not read the Easy-LLM vault format. How a native `chip` obtains a key (environment variable, prompt, its own store) is a host decision made in the Chip change, not here.
* **Local servers work.** LM Studio (for example `http://localhost:1235/v1`, no key) is supported with `OpenAiConfig::without_key`, which sends no `Authorization` header. Plain `http` is accepted for loopback hosts only.

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
| OpenRouter | same as OpenAI (optional attribution headers) | yes, same decoder | implemented through the OpenAI-compatible provider (`with_header` for `HTTP-Referer` and `X-Title`); mock-tested as OpenAI-compatible, not against OpenRouter |
| LM Studio | same as OpenAI, usually no key | yes | implemented (`without_key`); mock-tested, not against LM Studio |
| Ollama | NDJSON `/api/generate` (its OpenAI-compatible `/v1` endpoint also works here) | yes | the `/v1` endpoint only; native NDJSON not implemented |
| Anthropic | SSE messages API with typed events | yes | implemented |
| Google | JSON stream, no terminal marker | yes, but the stream cannot be verified complete | not implemented |

Libraries: `ureq` 3 (blocking HTTP) with `rustls` and bundled `webpki-roots`, and `serde_json` (already pinned in `fx-core`). No async runtime, no provider SDK, no OpenSSL. All were chosen because the rest of the FX graph is synchronous and blocking, and `ProviderPort` is a polled interface.

## Behavior

### One call

`invoke` validates the request, starts one worker thread, and returns. The worker makes exactly one `POST`, follows no redirects, ignores proxy environment variables (a proxy is only ever the host's explicit setting, below), and streams the response into a channel. `poll` waits up to 25 ms on that channel and returns what arrived. There is no retry, no fallback, no routing and no second request; `check-boundaries.sh` enforces a single `.post(` site in the source.

Trust roots: `https` endpoints are validated against the bundled `webpki-roots` unless the host calls `with_root_certificates_pem(pem)` on either config. That replaces the bundled roots with exactly the `CERTIFICATE` blocks in `pem` (other PEM items are ignored), for an endpoint behind a TLS-intercepting proxy or signed by a private CA. Validation stays on. A bundle that is not valid PEM or holds no certificate is a `ConfigError`. The host reads the bundle, for example from `SSL_CERT_FILE`; the crate still reads no environment or file.

Proxy: with `with_proxy("http://host:port")` on either config, the call goes through that HTTP `CONNECT` proxy. The tunnel carries the TLS session end to end, so certificate validation is unchanged; for a TLS-intercepting proxy, pass its CA with `with_root_certificates_pem`. `with_proxy_credentials(username, Secret)` authenticates to the proxy with Basic; the password never appears in a `ConfigError`, an error, an event or `Debug` output, and the endpoint never sees it. `with_no_proxy(host)` (`example.com`, `.example.com` or `*.example.com`) connects to matching hosts directly. Refused at configuration: a proxy URL that is not `http://host:port` (no `https`, SOCKS, path or credentials in the URL), credentials or exceptions without a proxy, a plain-http LAN endpoint (`without_key_on_private_lan`), and a keyed plain-`http` endpoint, whose credential the proxy would see in the clear. A proxy that cannot be reached, or refuses the tunnel (for example `407`), is the call's `transport` failure: there is no direct connection as a fallback. The host chooses the proxy; the crate never reads `HTTP_PROXY`, `HTTPS_PROXY` or `NO_PROXY`.

OpenAI-compatible: the body has the model reference, role-tagged text messages, `stream: true`, `stream_options.include_usage: true` and, when the request carries them, `max_tokens`, `temperature` (the contract's thousandths as a JSON number; `0` is sent as `0.0`, never dropped) and `response_format` as `{"type":"json_schema","json_schema":{"name","description","schema","strict":false}}` built from FX's response format. FX has already validated the schema as a JSON object. Consecutive system messages are sent as one message joined by a blank line, in order (some local servers' chat templates accept a single leading system message); a system message after another role stays where it is. The credential is only in the `Authorization` header.

OpenAI-compatible template thinking: `OpenAiConfig::with_chat_template_thinking(bool)` adds a top-level `"chat_template_kwargs":{"enable_thinking":<bool>}` member to every body. It is a host setting for a vendor extension that servers rendering a chat template (LM Studio, vLLM, Qwen-style models) read; it is not FX's reasoning effort, which stays refused, and it is never prompt text. It is absent unless set, because servers that do not know the field may reject it. The Anthropic adapter has no equivalent and carries nothing.

Plain `http` is accepted for loopback hosts only, except for one explicit exception: `OpenAiConfig::without_key_on_private_lan(url)` also accepts a private-network IP literal (RFC 1918 IPv4 or an IPv6 unique-local address) for a keyless inference server elsewhere on the LAN. It exists only on the keyless constructor, so no credential can be configured with it; such a configuration refuses extra headers; hostnames, public, link-local and unspecified addresses are still refused (a name can resolve to a public address); and redirects are never followed, so a LAN server cannot send the request elsewhere. The crate never reads the environment: the host decides whether to call this constructor. Anthropic has no such constructor.

Anthropic: the body has the model, user and assistant messages, system text as the top-level `system` field, `stream: true`, `max_tokens` and, when requested, `temperature` (above 1.0 is refused before dispatch because the API rejects it). Structured output is refused before dispatch: the Messages API has no equivalent that this adapter carries. The API requires `max_tokens`, so when the request does not carry `max_output_tokens` the host's `AnthropicConfig::with_default_max_tokens` value is used (default 4096); it is a visible setting, not a hidden constant. The credential is only in `x-api-key`; `anthropic-version` is `2023-06-01` unless the host sets another.

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

Anthropic stream: `message_start` supplies the model and input tokens, `content_block_delta` text deltas are the output, `message_delta` supplies the stop reason and output tokens, and `message_stop` is the terminal marker. `message_stop` without a stop reason is a protocol violation. `refusal` is reported as a content-filter finish, and `stop_reason: tool_use`, a `tool_use` block or an `input_json_delta` are protocol violations because no tools were offered. Thinking deltas carry no output, unknown event types are ignored, and an `error` event is a provider failure.

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

| Feature | Native (OpenAI-compatible and Anthropic) | Node (Easy-LLM OpenAI adapter) |
| --- | --- | --- |
| Text conversations (system, user, assistant) | supported | supported |
| Streaming with provider-verified completion | supported | supported |
| Usage on a stream | supported (when the endpoint sends it) | unverified for OpenAI; not carried for Anthropic |
| Finish reason on a stream | supported | supported for OpenAI; not carried for Anthropic |
| Output token cap (`max_output_tokens`) | supported | refused before dispatch |
| Sampling temperature (`temperature_milli`) | supported (Anthropic up to 1.0) | refused before dispatch |
| HTTP status and `Retry-After` | supported | supported |
| Refusal text and `content_filter` finish | supported | finish only |
| Non-streaming generation | not offered | supported |
| Tool definitions, tool choice, tool-call history, provider tools | refused before dispatch | refused before dispatch |
| Images | refused before dispatch | refused before dispatch |
| Reasoning effort, speed | refused before dispatch | refused before dispatch |
| Structured output (JSON schema) | OpenAI-compatible: supported; Anthropic: refused before dispatch | refused before dispatch |
| Prompt cache hints | ignored | ignored |
| Keyless local servers (LM Studio) | supported (`without_key`) | supported |
| Proxies | explicit HTTP `CONNECT` proxy with optional Basic credentials and no-proxy hosts (`with_proxy`); never from the environment | uses the Node `fetch` environment |
| mTLS | not supported (no client certificate) | uses the Node `fetch` environment |
| Custom CA certificates | host-supplied PEM roots (`with_root_certificates_pem`), replacing the bundled roots | uses the Node `fetch` environment |
| Remote cancellation confirmation | never confirmed (`unconfirmed`) | transport closing is observed |

"Refused before dispatch" is `ErrorKind::CapabilityUnavailable` with `definitely_unsent`, produced by the capability's support gate. The adapter has a second check that fails a tool message, a non-text part, a tool definition, reasoning effort, speed or structured output with `Unsupported` before any thread starts (`definitely_unsent`).

### Differences from the Node-backed path

Found by running the same scenarios through both paths (below). Each is recorded in `host/node/conformance/native-parity.mjs`, which fails if a difference changes or disappears.

| Scenario | Node (Easy-LLM) | Native |
| --- | --- | --- |
| Unparseable line inside a stream (both providers) | skipped; the attempt completes | protocol violation; text so far kept |
| Text after `[DONE]` (OpenAI) | included in the output (recorded Easy-LLM limitation) | never read |
| Tool call although none was offered (OpenAI) | surfaced as a proposal, then refused by FX | protocol violation; nothing surfaced |
| Anthropic stop for a tool call although none was offered | completes with finish reason `other` | protocol violation |
| Anthropic 200 response with no bytes | delivery `possibly_sent` | delivery `confirmed_response` (a complete 2xx response was received) |
| Anthropic stop reason and usage on a stream | not carried (finish reason `other`, usage unknown) | carried (`stop`, `length`, `content_filter`; token counts) |

Native is the stricter behavior wherever the two differ, and the more informative one for Anthropic streams. For that last row the parity script cannot compare with Node, so it checks the native values against the bytes the mock sent. Closing the Node-side gaps belongs to Easy-LLM and is not part of this change.

## Conformance

### What this proves, and what it does not

All evidence here is **mocked transport**: a deterministic HTTP server on loopback, a fake credential, no external network. It proves how the adapter and FX behave for those bytes. The TLS path with a private CA and the explicit proxy are exercised on loopback too (`tests/private_ca.rs`, `tests/proxy.rs`, below). It does **not** prove:

* anything about a live provider (no live request was made in this change; the wire format was written from the documented chat-completions stream and the Easy-LLM adapter's parsing);
* validation against the bundled `webpki-roots` for a public endpoint (only the refusal of a private CA by those roots is tested);
* behavior behind a real corporate proxy (the test proxy is a minimal `CONNECT` tunnel; proxy authentication schemes other than Basic are not supported).

One manual run exercised host-supplied roots: an `https` request to the Vercel AI Gateway through a TLS-intercepting egress proxy failed certificate validation (`UnknownIssuer`) with the bundled roots and completed the TLS exchange with the proxy's CA bundle passed to `with_root_certificates_pem`. It is not part of CI.

Live verification needs a real key (or a running LM Studio) and is out of scope for CI. To run one by hand, build `fx-native-provider` into a host, configure one provider (for example `AnthropicConfig::new("https://api.anthropic.com/v1", Secret::new(key))`, `OpenAiConfig::new("https://openrouter.ai/api/v1", ..)` or `OpenAiConfig::without_key("http://localhost:1235/v1")`) and execute one request; record the result separately from this document. Apart from the TLS run above, none has been run.

### Native conformance suite

`rust/fx-native-provider/tests/conformance.rs` (OpenAI-compatible, 30 cases) and `tests/anthropic.rs` (Anthropic, 18 cases) run through the real `fx_core::execute` and `SingleAttemptCapability`:

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

The Anthropic cases cover the same ground for the Messages format: stream normalization with usage, model and stop reason; request shape (`x-api-key`, `anthropic-version`, top-level `system`, required `max_tokens`, the host default and the request's cap); `max_tokens`/`refusal`/`stop_sequence` mapping; HTTP 401, 403, 404, 429, 500 and 529 with one connection each; error events; cut streams; missing stop reason; unoffered tool use; malformed JSON; unknown events and thinking deltas; refused features; cancellation before dispatch and in flight; budget timeout; closed connection; credential redaction; and configuration validation. `conformance.rs` also covers the output token cap, keyless endpoints and the extra-header rules.

`tests/proxy.rs` (6 cases) runs through a loopback `CONNECT` proxy: the call is tunnelled (the proxy sees exactly one `CONNECT` for the endpoint); a no-proxy host is reached directly; Basic credentials reach the proxy and nowhere else, and never appear in the report; a proxy that refuses the credentials or cannot be reached fails the call with the endpoint receiving no connection; and the configuration rules above.

`tests/private_ca.rs` (3 cases) generates a CA and a server certificate with the `openssl` command (test tooling only; the crate stays on rustls) and serves a canned stream from `openssl s_server` on loopback: with the bundled roots the handshake fails and the credential is not sent; with the CA from `with_root_certificates_pem` the call completes and the credential went inside TLS; a different CA is refused; and the same endpoint completes through the proxy, the tunnel carrying TLS end to end. Without `openssl` these cases print `SKIPPED` and pass; CI sets `FX_REQUIRE_TLS_TESTS=1`, which makes a missing `openssl` a failure.

Run: `cd rust/fx-native-provider && cargo test --locked`.

### Node versus native parity

`host/node/conformance/native-parity.mjs` starts the Node suite's own OpenAI mock server and, for each of 26 scenarios and for both providers (52 runs), runs the request through the Node-backed path (Easy-LLM adapter in the WebAssembly executor) and through the native example `native_parity`. Both outcomes are in FX's wire encoding. The script compares outcome type, finish reason, text, usage counts, error kind, origin, delivery certainty, status, retry-after and partial text. Result: 46 identical, 6 documented differences (above), 0 undocumented.

Run:

```
cargo build --manifest-path rust/fx-native-provider/Cargo.toml --example native_parity
cd host/node && npm run build:wasm && npm run conformance:native
```

## Chip integration readiness

The surface a host needs is small and already enough for `chip-fx`:

```rust
// Explicit, host-provided choices: the provider kind, endpoint, model and key.
let config = OpenAiConfig::new(base_url, Secret::new(api_key))?; // or without_key(..) for LM Studio
let mut capability = SingleAttemptCapability::new(OpenAiCompatible::new(config));
// or: Anthropic::new(AnthropicConfig::new("https://api.anthropic.com/v1", Secret::new(api_key))?)
let report = fx_core::execute(&mut capability, &request, &Limits::DEFAULT, &mut host);
```

Wiring `chip-fx` to this crate is a separate change in `rkendel1/chip-rs`. This change does not touch `chip-legacy-http` or the native `chip` binary, and the session-interop pin is unchanged. Before `chip-legacy-http` can be retired, the unavailable rows above that Chip needs (tool calling, JSON-object output, any sampling options) must be addressed, a native `chip` must have explicit provider selection and key handling, and a live-provider check against Anthropic, LM Studio and OpenRouter must be recorded.

## CI, licensing and platforms

* Workflow: `.github/workflows/native-provider.yml` runs fmt, Clippy with warnings denied, tests, a release build, the boundary script, the license script and the Node/native parity check on Linux and macOS.
* `check-boundaries.sh`: dependency allowlist, forbidden families (async runtimes, other HTTP stacks, OpenSSL, provider SDKs), exact manifest dependencies, source patterns (no environment, filesystem, processes, global state, async, retry or routing vocabulary), a single request site, and no Wasm-bound FX crate depending on this one.
* `check-licenses.py`: every crate in the graph on five native targets (Linux x86_64 and aarch64, macOS x86_64 and aarch64, Windows x86_64) has a permissive license. The graph has 38 crates: MIT, Apache-2.0, ISC, BSD-3-Clause, Unicode-3.0, Unlicense and CDLA-Permissive-2.0 (`webpki-roots`).
* Platforms: native only. The crate does not build for `wasm32-unknown-unknown` (checked: `getrandom`, pulled in by `ring` through `rustls`, has no backend there, and a Wasm module has no sockets anyway), so it is not part of the WebAssembly graph; `fx-core`, `fx-single-attempt` and `fx-host` do not depend on it, and their Wasm builds are unchanged. Windows is covered by the license graph but not built in CI.
* Dependency policy: `fx-core` and `fx-single-attempt` keep their I/O-free allowlists. This crate is the host-side exception for native transport and has its own allowlist ([ARCHITECTURE.md](ARCHITECTURE.md)).
