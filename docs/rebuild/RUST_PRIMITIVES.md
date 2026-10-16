# Rust primitive plan and design

Status: **accepted** (OD\-9 decided: Rust is the implementation language of the rebuilt core; the Zig implementation is the behavioral oracle until R5)\. R1, the contract crate, is implemented in `rust/fx-core`; see [ROADMAP\.md](ROADMAP.md)\. The original framing below is kept for the decision record\.

Related: [README\.md](README.md), [ARCHITECTURE\.md](ARCHITECTURE.md), [BEHAVIOR\_MATRIX\.md](BEHAVIOR_MATRIX.md), [ROADMAP\.md](ROADMAP.md), [DECISIONS\.md](DECISIONS.md), [CAPABILITIES\.md](CAPABILITIES.md)\.

## 1\. Recommendation

Build the provider\-neutral inference core as a small Rust library **only if Rust is an intentional requirement**\. Keep the same three logical primitives:

1. **Contract** — typed request, content, normalized events, outcome/error vocabulary, resource limits, and attempt lifecycle rules\.
2. **Executor** — exactly one inference attempt; validates, drives the capability boundary, normalizes events, enforces limits, and produces one terminal outcome\. It never retries or executes tools\.
3. **Runtime adapters** — Node and WASM host integrations\. They translate host inputs into the contract and deliver capability events; they do not create a second inference contract\.

Ownership remains:

- **FX:** inference contract, single\-attempt executor, stream normalization, cancellation semantics, runtime adapters\.
- **Easy\-LLM:** provider implementations, credentials, model registry, routing, transport, health, retries and fallback\.
- **Chip:** agent loop, tool execution, sessions, orchestration and recovery\.
- **Compute:** process and execution\-environment lifecycle\.
- **CLI/TUI:** consumer/shell code until ownership is resolved\.

**Do not introduce Rust alongside the Zig core as a second production implementation\.** If Rust is chosen, it replaces the planned `src/fx/*.zig` core before implementation PR 1\. The old Zig implementation remains the behavior oracle until migration is complete, not a second supported inference API\.

## 2\. Required language decision

The current architecture specifies a Zig implementation, a standard\-library\-only build, and Zig import\-boundary checks\. Rust adds Cargo and lockfile management, a native link/FFI boundary, a deliberate N\-API bridge, and a different WASM build strategy\. Rust ownership helps internal memory safety but does not itself bound buffers, validate untrusted JSON, or solve cancellation\.

Add **OD\-9: implementation language**:

- **A\. Keep Zig:** lowest migration risk; follow the existing roadmap\.
- **B\. Replace the planned core with Rust:** choose only if Rust interoperability/ecosystem is a product requirement\.
- **C\. Maintain both:** reject due to duplicated semantics and conformance burden\.

No production implementation should begin until this decision is recorded\. If B is selected, update `ARCHITECTURE.md`, `ROADMAP.md`, README, CI/build checks, and risk register so one language is normative\.

## 3\. Crate and module layout

```text
rust/fx-core/
  Cargo.toml
  Cargo.lock
  rust-toolchain.toml
  src/
    lib.rs              # public Rust API; curated re-exports
    contract.rs         # request, parts, events, outcomes, errors, limits
    validate.rs         # request and history structural validation
    capability.rs       # one-attempt capability boundary
    executor.rs         # one-attempt state machine
    normalize.rs        # event validation and terminal normalization
    diagnostics.rs      # bounded, redacted summaries
    ffi/
      mod.rs
      c_api.rs          # optional stable C ABI
      json.rs           # boundary serialization only
    adapters/
      mod.rs
      napi.rs           # only if N-API remains in this repo
      wasm.rs           # host-driven reactor ABI
  tests/
    contract_roundtrip.rs
    executor_fixtures.rs
    adversarial.rs
    cross_runtime.rs
```

Core modules are `contract + validate + capability + executor + normalize + diagnostics`\. Adapter code is separate and cannot leak host\-specific types into the core\.

Dependency policy:

- Core uses Rust standard library only initially\.
- No async runtime, HTTP/TLS client, provider SDK, credential store, filesystem, process, environment or network access in core\.
- If Serde is approved for boundary encoding, pin it and test malformed/oversized input before deserialization\. It must not become the semantic source of truth\.
- Avoid open\-ended stringly errors, global mutable state, and hidden runtime initialization\.
- Build/test native and `wasm32-unknown-unknown`; WASM is a reactor, not a WASI command\.
- Add a pinned toolchain, lockfile, formatting/lint/test/target\-build and size gates without weakening existing Zig product gates\.

## 4\. Contract design

Use owned, explicit data at public boundaries\. References may borrow request data during one execution, but borrowed pointers must not escape an FFI call or be retained by a capability without explicit ownership transfer\.

Illustrative Rust shape &#40;names are proposed, not yet a frozen API&#41;:

```rust
pub const CONTRACT_VERSION: u32 = 1;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelRef(pub String); // opaque to FX

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role { System, User, Assistant, Tool }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CacheHint { Default, NoCache, Breakpoint }

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Part {
    Text(String),
    Image { media_type: String, bytes: Vec<u8> },
    ToolCall(ToolCallProposal),
    ToolResult(ToolResult),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Message {
    pub role: Role,
    pub parts: Vec<Part>,
    pub cache: CacheHint,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub input_schema_json: String,
    pub execution: ToolExecution, // Client or Provider
    pub provider_args_json: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ToolChoice { Auto, None, Required, Named(String) }

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReasoningEffort { Default, Named(String) } // opaque label

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GenerationOptions {
    pub max_output_tokens: Option<u32>,
    pub temperature_milli: Option<u16>, // thousandths; at most 2000
    pub reasoning: ReasoningEffort,
    pub speed: Speed,
    pub response_format: Option<ResponseFormat>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Request {
    pub model: ModelRef,
    pub messages: Vec<Message>,
    pub tools: Vec<ToolDefinition>,
    pub tool_choice: ToolChoice,
    pub options: GenerationOptions,
    pub correlation: Correlation,
    pub deadline: Option<Deadline>,
}
```

Before freezing the contract, decide:

- Use a duration or host\-monotonic deadline internally; do not serialize a process\-specific monotonic instant across processes\. Wall\-clock timestamps are diagnostics only\.
- Image data is bytes plus a validated media type, never a local path or implicit URL fetch\. Bound per\-image and aggregate request bytes\.
- FX performs bounded schema syntax/structure checks\. Easy\-LLM owns provider\-specific response\-format mapping\. Decide once whether FX validates completed output against schema; avoid duplicate validation authority\.
- Tool names and IDs have distinct syntax and length limits\. Preserve observed proposal records even if admission rejects them\.
- Model ID, generation ID, cost and provider\-reported model are opaque\. FX must not parse provider slugs or assume currency\.
- Wire decoding rejects unknown tags and invalid enum values deterministically; never transmute raw discriminants into Rust enums\.

## 5\. Events and terminal outcomes

The capability supplies typed events; the executor validates and normalizes them\. Streaming deltas are observations, not authoritative completed tool calls\.

```rust
pub enum Event {
    Metadata(Metadata),
    TextDelta(String),
    ReasoningDelta(String),
    ToolInputStart { id: String, name: String },
    ToolInputDelta { id: String, delta: String },
    ToolCallProposal(ToolCallProposal),
    ProviderToolRecord(ProviderToolRecord),
    Usage(Usage),
    Finish { reason: FinishReason },
}

pub enum Outcome {
    Completed(Completion),
    Failed(Failure),
    Cancelled(Cancelled),
}
```

Keep distinct:

- streamed tool\-input fragments vs a completed proposal;
- model proposal vs provider\-reported provider\-side execution;
- observer\-delivered text vs bounded accumulated completion;
- stream framing completion vs valid terminal finish;
- completion vs cancellation vs failure\.

A stream ending without a valid finish is interrupted, even if partial text exists\. Finish is terminal; later events are protocol violations and cannot overwrite the first committed terminal result\. Race policy must be deterministic and tested\.

`Completion.content` has a hard byte limit and explicit truncation indicator\. Observers receive valid deltas subject to event bounds/backpressure; concatenated observer deltas need not equal bounded completion content when accumulation truncates\. Reasoning is forwarded but not retained unless an explicit retention policy is approved\.

## 6\. Capability: exactly one attempt

The FX\-defined capability boundary is implemented by Easy\-LLM\. It must not become a provider registry or expose provider\-specific HTTP objects\.

```rust
pub trait Capability {
    type Handle;

    fn start(&mut self, request: &Request)
        -> Result<Self::Handle, CapabilityError>;

    fn poll(&mut self, handle: &mut Self::Handle, max_events: usize)
        -> Result<PollBatch, CapabilityError>;

    fn cancel(&mut self, handle: &mut Self::Handle) -> CancelStatus;
    fn close(&mut self, handle: Self::Handle);
}
```

This non\-blocking semantic shape is host\-driveable and requires no async runtime in the core\. `poll` is bounded and cannot block indefinitely\. A batch is pending, contains a bounded number of events, or reports failure\. Cancellation and close semantics are explicit\. An implementation may use async internally but must bridge without moving provider retry/routing policy into FX\.

If Easy\-LLM requires a Rust\-native async trait, keep it behind an adapter; do not expose runtime\-specific types in stable C/WASM ABIs\. The concrete Easy\-LLM interface remains an open decision and must be agreed before binding PR 3\.

The executor invokes one start, consumes events to one terminal outcome, and cleans up\. It does not select models, retry, refresh credentials, reconnect, or choose fallback\. Easy\-LLM owns provider/transport retries under explicit delivery\-certainty policy; Chip owns turn\-level recovery\.

## 7\. State machine and invariants

```text
Created -> Validating -> Starting -> Streaming -> Terminal -> Closed
               |            |           |
               +------------+-----------+--> Failed
               +----------------------------> Cancelled
```

Required invariants:

1. Exactly one terminal outcome per execution\.
2. Invalid requests fail before capability invocation\.
3. No provider retry or model fallback in FX\.
4. Delivery certainty is monotonic: DefinitelyUnsent \-\> PossiblySent \-\> ConfirmedResponse\.
5. Cancellation does not prove the remote operation did not execute\.
6. Local cancellation cleanup is bounded; never claim remote cancellation if the capability cannot confirm it\.
7. No events accepted after terminal state\.
8. Events, proposals, buffers, accumulated content and diagnostics are bounded\.
9. A tool proposal is not execution authority\. Admission validates identity, syntax, arguments, duplicates and consistency; Chip decides whether/how to execute\.
10. Diagnostics contain metadata only, never prompts, image bytes, tool arguments/results, credentials or full provider error bodies\.
11. No ambient filesystem, environment, network, process, credential or clock\-dependent configuration access\.
12. Every per\-execution allocation is released on success, error, cancellation, abandonment and adapter teardown\.

Use explicit per\-execution state; avoid global mutable state\. Never hold a mutex while calling host code\.

## 8\. Resource limits and cancellation

Freeze one `Limits` structure with tested defaults for:

- serialized request bytes;
- message and part counts;
- image bytes per image and in aggregate;
- event bytes and events per poll;
- tool proposal count and ID/name lengths;
- accumulated text bytes;
- pending event bytes;
- diagnostic detail bytes;
- host polling and local cancellation cleanup bounds\.

Choose exact numeric defaults from observed behavior and workloads; record them in one table\. Do not independently invent limits in Rust, N\-API and WASM\.

Rust RAII helps internal cleanup but is not an asynchronous cancellation handshake\. On consumer abandonment, cancel, drain/close per capability contract, release handles, and make worker termination observable\. If a provider cannot be interrupted, adapter cleanup must still be bounded\. Use bounded pull/poll batches to prevent unbounded buffering when the host is slow\.

## 9\. Node/N\-API adapter

Expose inference, not the ACP agent server\. Keep a clear major\-version break rather than ambiguously changing the meaning of existing SDK methods\.

```ts
const inference = createInference({ capability });
const controller = new AbortController();
const execution = inference.execute(request, { signal: controller.signal });

for await (const event of execution.events) {
  // ordered normalized events
}
const outcome = await execution.outcome;
```

Rules:

- JS owns JS objects/callbacks; Rust owns its allocations\. Handles use opaque IDs plus generation/slot validation and exactly\-once destruction\.
- Never hold a Rust mutex while invoking JS\. Never call JS from arbitrary native workers without the appropriate N\-API thread\-safe mechanism\.
- Use a thread\-safe function or explicitly polled async iterator; no fixed 2 ms polling loop\.
- Test cancellation before admission, pending first event, streaming, after finish, and teardown\.
- Test worker termination and consumer abandonment separately\.
- Retain a bounded handle/slot cap and stable typed error when exceeded\.
- Avoid native HTTP in the addon initially; caller supplies capability unless OD\-2 explicitly authorizes linking native Easy\-LLM\.
- Version adapter API independently and test misuse, stale handles, double destroy, slot exhaustion, callback failure and worker termination\.

## 10\. WASM reactor ABI

Target `wasm32-unknown-unknown`; no WASI, filesystem, sockets, process, threads, JSPI or suspending imports\.

Conceptual host\-driven ABI:

```text
fx_create(contract_version, limits_json) -> handle
fx_begin(handle, request_ptr, request_len) -> status
fx_push_event(handle, event_ptr, event_len) -> status
fx_poll(handle, output_ptr, output_capacity) -> PollResult
fx_cancel(handle) -> status
fx_close(handle) -> status
fx_last_error(handle, output_ptr, output_capacity) -> status
```

Before implementation define integer widths, pointer/length validation, UTF\-8 validity, memory ownership, reentrancy, maximum memory, output truncation, error\-code stability, and whether JSON is the first ABI encoding\. Never expose Rust enum layout, `String`, trait objects or Rust allocator\-owned structures directly across WASM\.

The host pushes capability events and polls normalized output under strict per\-handle bounds\. WASM is not itself a CPU inference engine\. CPU or accelerated execution is a capability implementation, not a property of the contract\. The new reactor must not require JSPI\.

## 11\. FFI, decoding and errors

Keep the internal contract typed\. JSON is boundary interchange, not the executor’s internal event representation\.

- Use explicit versions and tagged unions\.
- Validate lengths before allocating/parsing\.
- Reject invalid UTF\-8, unknown tags, duplicate required fields, invalid enum values, oversized payloads and trailing garbage deterministically\.
- Use stable integer error codes at C/WASM boundaries and bounded diagnostic text\.
- Allocate output buffers in Rust and provide a matching Rust free function; never free Rust allocations with another allocator\.
- Avoid `repr(C)` for nested Rust types\. Use opaque handles, fixed\-width scalars, pointer/length pairs and versioned structs if C ABI is required\.
- Fuzz decoding and handle lifecycle; add sanitizer/Miri coverage where supported\.

Closed `ErrorKind`:

- invalid request;
- capability unavailable;
- unauthenticated;
- forbidden;
- model unavailable;
- rate limited;
- timeout;
- cancelled;
- transport;
- protocol violation;
- resource limit;
- internal\.

Separate executor\-generated validation/lifecycle errors from capability errors\. Do not flatten errors to strings or infer remote non\-execution from local timeout\. HTTP status, provider codes, retry\-after parsing and HTTP body caps belong to Easy\-LLM transport; FX receives normalized errors and tests delivery certainty/terminal behavior\.

## 12\. Conformance and migration plan

`BEHAVIOR_MATRIX.md` remains the behavioral source of truth\. Do not rewrite it to fit Rust\. Reuse its JSON fixtures against the legacy Zig oracle, Rust core, then native/N\-API/WASM adapters\.

### R0 — Language decision and spec reconciliation

- Decide OD\-9 &#40;Zig or Rust&#41;\.
- If Rust, update ARCHITECTURE, ROADMAP, README, boundary checks and risks\.
- Resolve Easy\-LLM, N\-API capability, WASM ABI, temporary Gateway adapter and malformed\-event policy decisions as their gates require\.
- Freeze numeric limits, wire tags, terminal race policy, proposal\-set rejection policy and allocation ownership\.
- Reconcile inventory totals, including the `client.zig` test\-group arithmetic\.

**Exit:** one normative design with no conflicting language/build instructions\.

### R1 — Contract crate

- Add crate, pinned toolchain and lockfile\.
- Implement types, bounded decoding, request validation and round\-trip tests only\.
- Do not connect product code or Easy\-LLM\.
- Add import/dependency boundary checks\.

**Exit:** contract tests pass; invalid/oversized requests reject before capability invocation\.

### R2 — Executor and fixtures

- Implement state machine, fake capability, normalizer, diagnostics and limits\.
- Port BM\-01–BM\-11, BM\-15, BM\-17 and A\-1–A\-13\.
- Add allocation\-failure, malformed\-input, concurrency, cancellation, abandonment and throughput tests\.
- Run parity against the Zig oracle\.

**Exit:** deterministic native conformance without network, credentials or provider dependencies\.

### R3 — Easy\-LLM binding

- Implement the agreed capability bridge; no duplicate registry/routing/credentials\.
- Keep the legacy Gateway capability outside the core only if needed to keep the shell working, with a fixed deletion PR\.
- Collapse agent, web\-search and permission\-review inference calls onto one executor while keeping consumer policy with owners\.

**Exit:** no compile\-time provider choice or provider implementation inside FX core\.

### R4 — Node and WASM

- Implement host capability bridge, N\-API lifecycle and WASM reactor\.
- Reuse the same fixtures and normalized outcomes\.
- Existing JSPI tests may remain as regression checks for old artifacts, but new WASM must not depend on JSPI\.
- Add import allowlist, ABI fuzzing and memory/handle bounds\.

**Exit:** equivalent outcomes for every applicable native/N\-API/WASM fixture\.

### R5 — Consumer migration and removals

- Migrate consumers and tests per ownership/removal ledgers\.
- Move recovery to Chip, provider concerns to Easy\-LLM, process/sandbox concerns to Compute\.
- Update PGSO corpus with each E2E move/removal\.
- Remove legacy Gateway/Vercel surfaces only when replacement and consumer impact are verified\.

**Exit:** no duplicate seam, unowned behavior or unexplained deleted tests\.

### R6 — Production readiness

- Full CI on every supported runner, recorded at exact commit\.
- ABI/API compatibility and migration notes\.
- Benchmark startup, memory, event throughput, cancellation latency and binary/WASM size\.
- Verify licenses/notices\.

**Exit:** all conformance, performance, security and release gates pass\.

## 13\. Required tests and done criteria

Add tests for contract round trips and unknown versions; enum/tag/length boundaries; invalid UTF\-8 and malformed/oversized JSON; empty/max content and images; duplicate/conflicting proposals; finish twice and events after finish; EOF without finish and partial stream failure; cancellation races and repeated cancel; capability start/poll/close failures; abandonment cleanup; allocation failure at every growth point; concurrent isolation; stale/double\-destroyed handles and slot exhaustion; cross\-runtime fixture parity; diagnostics redaction; and static checks for forbidden dependencies\.

Definition of done:

- [ ] Language decision approved; docs/build instructions agree\.
- [ ] One public contract and executor; no duplicate Zig/Rust production core\.
- [ ] Core has no provider, network, filesystem, process or async\-runtime dependencies\.
- [ ] Every retained behavior in `BEHAVIOR_MATRIX.md` maps to deterministic tests\.
- [ ] Exactly one terminal outcome and monotonic delivery certainty are enforced\.
- [ ] Request, event, completion, diagnostic, queue and handle sizes are bounded\.
- [ ] Capability and executor errors remain distinguishable\.
- [ ] Node/WASM preserve the same normalized contract\.
- [ ] WASM is host\-driven and JSPI\-independent\.
- [ ] Easy\-LLM owns provider routing, credentials, transport and retries; Chip owns orchestration and tools\.
- [ ] Full CI, cross\-runtime conformance, performance and release gates are green\.
