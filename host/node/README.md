# fx-host-node

Run an FX request through the Rust FX executor (WebAssembly) against an explicitly chosen Easy-LLM provider. One entry point; the executor stays the only authority on validation, event order, bounds, delivery certainty and the final outcome. This package schedules the provider call and translates between the two.

Design, guarantees and limits: [`docs/rebuild/HOST_BRIDGE.md`](../../docs/rebuild/HOST_BRIDGE.md). This package is not production ready (see "Not production ready" there).

## Use

```js
import * as easyLlm from "@easy-llm/llm";
import { createFxRuntime } from "fx-host-node";

const fx = await createFxRuntime({ easyLlm });                    // wasm defaults to the repository build

const provider = easyLlm.createOpenAIAdapter(process.env.OPENAI_API_KEY); // you construct it; the key stays with Easy-LLM
const { report, events, host } = await fx.execute(
  {
    v: 1,
    model: "gpt-4o-mini",
    messages: [{ role: "user", parts: [{ type: "text", text: "Say hello." }] }],
    correlation: { request_id: "00112233445566778899aabbccddeeff" },
    budget_ms: 30_000,                                             // optional; enforced by Easy-LLM
  },
  { provider, mode: "stream", signal, onEvent: (event) => {} },
);
console.log(report.outcome);   // completed | failed | cancelled, in fx-core's wire shape
```

- `provider` is required. It is an Easy-LLM provider object, or the id of a provider you registered with Easy-LLM. Nothing here selects, routes to, retries or falls back to another provider.
- `mode` is `"stream"` (`streamOnce`) or `"generate"` (`generateOnce`). It defaults to `"stream"` for a provider object that has `stream`, and is otherwise required. It is fixed before the call and never changes after a failure.
- `request` is bytes, a JSON string or an object. Pass bytes if you need exact, strict decoding (duplicate keys are rejected as sent).
- `execute` resolves with a report for every provider failure, timeout, cancellation and validation outcome. It rejects only for programming errors: no provider given, or the module misbehaving (`HostProtocolError`).
- `signal` cancels. `onEvent` receives each normalized FX event in order; returning `false` abandons the attempt.
- `host` has content-free facts: whether the provider was invoked, its id, what it declared about its own retries and whether it forwards the abort signal.

The report is `{ outcome, proposal_checks, disposition, diagnostics }`. Tool-call proposals come back as data in `outcome.proposals`. Nothing is executed.

## What a request may contain today

Text messages only. Requests that use images, tool definitions, tool-call history, tool choice, generation options, structured output or provider-executed tools fail with `capability_unavailable` and `delivery: definitely_unsent` before the provider is invoked. This is the Easy-LLM provider layer's current reach (docs/rebuild/SINGLE_ATTEMPT.md "Gaps"), not an FX limit.

## Install and test

```bash
npm ci                 # Easy-LLM comes from the npm registry, pinned to an exact release
npm run build:wasm     # needs the Rust toolchain pinned in ../../rust-toolchain.toml
npm run typecheck
npm run lint
npm test               # offline: no network, no credentials
npm run conformance    # provider conformance: all five adapters, manifest check
npm run example:mock   # real OpenAI adapter -> local mock endpoint -> FX outcome
```

To compare WebAssembly against the native Rust run, as CI does:

```bash
(cd ../../rust/fx-host && FX_CONFORMANCE_OUT=/tmp/native.json cargo test --locked --test conformance)
FX_CONFORMANCE_NATIVE=/tmp/native.json npm test
```

## Provider conformance

`npm run conformance` runs the same cases against the real Easy-LLM OpenAI, OpenRouter, Anthropic, Google and Ollama adapters, each pointed at a local mock of its endpoint, through the Rust executor. It prints results by provider and case, checks `conformance/manifest.json` against them (a feature may be `supported` only if passing cases show it), and needs no credentials or network. Results: [`docs/rebuild/PROVIDER_CONFORMANCE.md`](../../docs/rebuild/PROVIDER_CONFORMANCE.md). Every status is mock-backed; no live provider has been verified.

Optional live smoke test (never run by CI, spends tokens): `FX_LIVE_SMOKE=1 OPENAI_API_KEY=... FX_LIVE_MODEL=... npm run example:live`.

## Chip over FX

`createChipRuntime` (exported from `src/index.js`) loads Rust Chip's module (`chip_wasm_host.wasm`, built from `rkendel1/chip-rs`) and drives it with this package: Chip's inference goes through FX, then the Easy-LLM adapter you pass; Chip's tool proposals are returned to your capability handler, which decides whether to run them. Offline example (no credentials): `CHIP_WASM=/path/to/chip_wasm_host.wasm npm run example:agent`. Tests and Zig parity: `npm run test:chip`. Design and differences: [`docs/rebuild/CHIP_FX_RUNTIME.md`](../../docs/rebuild/CHIP_FX_RUNTIME.md).

## Configuration

None of its own. Provider credentials and endpoints are configured on the Easy-LLM provider you pass in. This package never reads the environment, the filesystem (other than the module file you point it at) or the network.
