# Chip on the authoritative FX (R6)

This repository owns the one authoritative FX (`rust/fx-core`, `rust/fx-single-attempt`,
`rust/fx-host`, `host/node`). Rust Chip lives in `rkendel1/chip-rs`. This document records how the two
fit together, what was reused, what was retired, and what is deliberately not claimed. The chip-rs side
is `docs/product/authoritative-fx.md` there.

## Dependency direction

```
Agent consumer -> Unified runtime (host/node createChipRuntime) -> Chip (chip-wasm-host, chip-core)
   -> chip-inference (Chip-owned model port) -> chip-fx (adapter) -> fx-core + fx-single-attempt
   -> provider port -> Easy-LLM adapter -> provider
```

FX never depends on Chip. Chip never calls a provider except through FX. FX has no retry, fallback or
routing. A proposed tool call is untrusted data until the host authorizes and runs it.
`docs/rebuild/tools/check_retirement.py` checks the FX side of this on every PR.

## Reconciliation: source-level comparison

Compared were the toy `fx-core` and `fx-provider-http` that Rust Chip carried, the authoritative Rust
FX, and the Zig CLI.

| Dimension | chip-rs toy FX | Authoritative Rust FX | Zig `fx ask` |
| --- | --- | --- | --- |
| Request model | text plus free options | typed request, support flags | provider-native messages and tools |
| Delivery certainty | none | three levels, never lowered | none |
| Result | string or error | execution report with disposition | session events |
| Retry | none | none, by contract | repeats after ambiguous outcomes |
| Provider I/O | reqwest in the crate | host port, Easy-LLM adapters | Zig HTTP client |
| Portable build | no | wasm32, zero imports | no |
| Conformance | local tests | five adapters, manifest and doc checked | binary tests |
| Tool use | none | refused, proposals are data | provider-native loop |
| Persistence | none | none (host decides) | Zig-owned session store |

Outcome: Chip keeps its own loop and port. Inference execution is replaced by the authoritative FX
through the explicit adapter `chip-fx`. The duplicate FX core in chip-rs is removed.

## Responsibility map

| Responsibility | Owner | Notes |
| --- | --- | --- |
| One provider attempt, delivery certainty, report | FX (`fx-core`) | authoritative |
| Provider wire formats | Easy-LLM `@easy-llm/llm@0.10.2` | published package, via host |
| Work loop, decision schema, terminal states, limits | Chip (`chip-core`) | no retry doctrine |
| Chip to FX mapping | `chip-fx` | adapter only |
| Portable Chip module | `chip-wasm-host` | no imports, shared `fx-wasm-abi` |
| Tool execution and authorization | host capability | Chip proposes, host runs |
| Session persistence | Zig (`~/.fx/sessions`) | unchanged, not duplicated by Chip |
| TUI, ACP, SDK | Zig | unchanged |

## Intentional differences from the Zig oracle

The oracle is `docs/rebuild/evidence/zig-oracle.json`, recorded from the real `zig-out/bin/fx` by
`docs/rebuild/tools/capture_zig_oracle.py` against a scripted gateway. `host/node/test-chip/parity.test.mjs`
runs the Chip side for real and pins both sides of each difference.

* D1 Zig repeats the provider request after an ambiguous outcome (429, 500, a cut stream), observed
  with the real binary. Chip over FX never does: it makes one request and ends the work with the
  evidence. Repeating is allowed only for provably unsent requests, and chip-rs never retries.
* D2 Zig sends sampling options and a system prompt. The FX path does not carry caller-chosen ones.
  Options policy is explicit (`Refuse` or `DropUnsupported`), never a default. The Easy-LLM OpenAI
  adapter still applies its own fixed `temperature: 0.7`; that is the adapter's behavior, observed
  and pinned in the parity test, not something Chip or FX sends.
* D3 Zig reports an unknown tool or malformed arguments back to the model and continues. Chip fails
  closed without repair.
* D4 Zig uses provider-native tool definitions. Chip uses text decisions (`chip.work-decision.v1`) and
  FX refuses tools.

Equivalent outcomes are tested for a single answer, a tool round trip (two inferences, capability run
once) and the step limit.

## Retirement plan

Machine-checked by `docs/rebuild/tools/check_retirement.py` against `docs/rebuild/retirement.json`.

* Duplicate FX core in chip-rs: retired. Gate: no `fx-core` or `fx-provider-http` crate in chip-rs.
* `chip-legacy-http` in chip-rs: kept, BLOCKED. Blocker: the native `chip` binary has no Easy-LLM
  host. The consumer ratchet in chip-rs may only shrink.
* Zig responsibilities: not retired. Blockers, each unported: permission modes (ask, auto, yolo),
  provider tool-call loop, session persistence and event-log format, silent-tool continuation,
  step-limit pause semantics, interrupted-turn persistence, TUI, ACP, SDK.

## How to run

Documented entry point: `host/node` `createChipRuntime`, exported from `host/node/src/index.js`.

```
cargo build --manifest-path rust/fx-host/Cargo.toml --locked --release --target wasm32-unknown-unknown
# build chip_wasm_host.wasm in rkendel1/chip-rs, then:
cd host/node && npm ci
CHIP_WASM=/path/to/chip_wasm_host.wasm npm run example:agent   # offline multi-step, one authorized tool
CHIP_WASM=/path/to/chip_wasm_host.wasm npm run test:chip       # integrated tests and parity
```

The example runs Chip (wasm), FX (wasm), the real Easy-LLM OpenAI adapter and a local mock endpoint.
Expected result: state completed, two inferences, one execution.

## Not claimed

Live provider runs, Zig CLI replacement, persistence in Chip, and native `chip` binary on FX.
