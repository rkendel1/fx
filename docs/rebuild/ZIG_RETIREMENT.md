# Retiring Zig: inventory, order and gates

Measured on `main` (`find src -name '*.zig'`): **543 files, about 684,000 lines** under `src/`, plus two Zig test files, before the
dead-code removal below. No Zig behaviour is retired yet; only unreachable Zig code is (see **Retired so far**). This document is the plan;
`docs/rebuild/retirement.json` holds the machine-checked gates and `docs/rebuild/tools/check_retirement.py` enforces them. A gate is met
only when that script proves it.

## Retired so far

| Entry | What went | Gate |
| --- | --- | --- |
| `zig-dead-code` | 69 container-level `fn`/`const` declarations in 39 files whose name occurred only at the definition, and three re-export facades (`src/core/background/background.zig`, `src/gateway/web_search.zig`, `src/gateway/web_search_types.zig`) that only `main.zig`'s test block imported. About 540 lines, deletions only. | `zig_dead_code.py --check` reports zero, and the facade paths are absent |

The scan that found these is a name-based token count, not a proof of semantic unreachability (its limits are in the docstring of
`docs/rebuild/tools/zig_dead_code.py`). Each deletion was confirmed by building the binary, the WASM core and term surfaces, the N-API
surface and the three benchmarks, and by running the unit suite against an unmodified `main` baseline. The gate keeps the count at zero,
so code orphaned by later retirement steps has to leave with them. A future hit is a candidate to verify the same way, not a licence to
delete.

## What Rust owns today

| Behaviour | Rust owner | Status |
| --- | --- | --- |
| One authoritative inference attempt (`execute`, delivery certainty, cancellation, budget) | `rust/fx-core`, `rust/fx-single-attempt` | done, conformance-tested |
| OpenAI-compatible and Anthropic providers (streaming, structured output, credentials) | `rust/fx-native-provider` + chip-rs `chip-fx-native` | done; live-checked by the owner for Anthropic and LM Studio (raw output not in the repo); OpenRouter not run |
| Chip work loop with text decisions, capabilities, audit | chip-rs `chip-core`, `chip-cli` | done; **default executor is fx** |
| Session files in the Zig-compatible format, turn commit/recover | chip-rs `chip-session`, `chip-turns` | done for Chip turns; cross-implementation resume CI |
| Wasm host for FX | `rust/fx-wasm-abi`, chip-rs `chip-wasm-host` | done |

## What Zig still owns (size, by directory)

| Area | Zig lines | Rust equivalent | Blocker |
| --- | ---: | --- | --- |
| `src/core` (agent, execution, permissions, session, mcp, hooks, config, auth, subagents, tasks, ...) | ~492,000 | partial: executor, providers, Chip loop, session format | the agent loop and everything it drives |
| `src/ui` (TUI) | ~129,000 | none | no Rust TUI |
| `src/tools`, `src/builtins` | ~39,000 | partial: Chip capabilities (compute, project read, PAX) | file/shell/web/skills/memory tools not ported |
| `src/acp`, `src/gateway` | ~18,000 | none | no Rust ACP or gateway |
| `src/*_main.zig` (N-API, WASM, term) | small | none | the shipped SDK is built from these |

Per-file ownership is in `docs/rebuild/inventory/` (generated; do not edit by hand).

## Order, each step its own reversible PR

1. **Finish the executor transition** (in progress): every Chip model-calling command is on fx; `chip-legacy-http` is an explicit
   option. Next: move `HttpProviderConfig` out of the legacy crate, decide Ollama's own API, then delete the crate when its consumer
   list is empty.
2. **Agent loop** (`zig-agent-loop`). Gate: a recorded parity run of turn, tool, cancellation and recovery against the Zig loop for the
   scenarios in `docs/rebuild/BEHAVIOR_MATRIX.md`, plus the four listed blockers (permission modes, provider-native tool calls,
   silent-tool continuation, step-limit pause). Only then does Zig stop being the loop of record for `fx ask`.
   **Status (recorded 2026-10-16).** The fresh-build reproduction blocker is **met**: the `agent-parity` workflow passed on `main` with a
   freshly built Zig binary and Rust Chip, and the result agreed with `docs/rebuild/evidence/agent-parity.json`
   ([run 38974849416](https://github.com/rkendel1/fx/actions/runs/38974849416), commit `6e9f7be`). That establishes reproducibility for the
   approved corpus only. It is not complete behavioral equivalence and not readiness to remove the wider Zig agent infrastructure.
   `zig-agent-loop` **stays `blocked`**: the retirement diff has not been reviewed, no import map of `src/core/agent` exists, and the corpus
   does not cover the TUI, ACP, gateway, MCP, hooks, tasks or subagents. The `retirement_ready` flag inside `agent-parity.json` is a
   statement about the corpus gate, not about this entry. Nothing is deleted or disabled.
   **Next (proposed, not implemented):** an explicit opt-in route `fx ask --executor chip`, with the Zig loop as the default. The two
   commands' contracts, the gaps a route cannot hide, and the owner decisions it needs are in `docs/rebuild/ASK_CHIP_ROUTING.md`.
3. **Persistence** (`zig-persistence`). Gate: Rust is the only writer for a session started by Rust, and Zig can resume it (already
   covered) and the reverse, including interrupted turns.
4. **Surfaces** (`zig-surfaces`), in dependency order: tools/builtins, MCP, gateway, ACP, SDK entry points, TUI last (it depends on
   everything below it). Each needs its own inventory row, parity test and removal PR.
5. **Delete** Zig sources only in the PR that makes the corresponding gate in `retirement.json` pass, with `check_retirement.py`
   verifying the path is gone.

## What `check_retirement.py` rejects today

- a Rust crate depending on a Chip crate; a second `execute` entry point; an HTTP client under the executor crates;
- a blocked entry that names no blockers;
- **new:** any Rust manifest or `build.rs` that mentions Zig, and any Rust source that references `zig-out`, `build.zig` or `libfx`,
  so Rust cannot quietly come to depend on Zig outputs while Zig is being retired;
- a `retired` entry whose `paths_absent` still exist, or whose `check` script fails (today: `zig-dead-code`, which runs
  `zig_dead_code.py --check`).

Each later Zig area moves to `retired` the same way: its deleted paths go in `paths_absent` in the PR that deletes them.

## Not claimed

No Zig behaviour has been shown to be reproduced in Rust except what the table above marks done. The Zig CI failure "SDK (Node +
N-API)" (`sdk/fx-core.wasm` missing in `test-libfx-loader`) is pre-existing and unrelated; it should be fixed or the test retired with
the SDK.
