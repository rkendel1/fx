# Decisions

Each entry gives the evidence, the options and a recommendation or decision. Each one changes the architecture or the R0–R6 sequence in [ROADMAP.md](ROADMAP.md), which marks the step it blocks. Decided: OD-5 (WASM reactor ABI), OD-8 (reject malformed events) and OD-9 (Rust). Open: OD-1, OD-2, OD-3, OD-4, OD-6, OD-7.

## OD-1: What happens to the product shell and the in-repo agent loop?

**Evidence.**
- 303 files and about 346,000 lines are classified `fx-shell`.
- About 318 files and 355,000 lines are classified as Chip-owned behavior ([inventory/summary.md](inventory/summary.md)).
- Chip is not present in this workspace ([BASELINE.md](BASELINE.md), "Consumers").
- The brief puts Chip in charge of the agent loop. It also rules out rebuilding Chip in this program.
- The CLI/TUI has no assigned owner.

**Options.**
1. Move the agent loop and shell to Chip now. This cannot be verified here, because Chip's code is unavailable.
2. Keep both in this repository as consumer #1 of the new Rust core (`rust/fx-core`). Enforce the boundary mechanically, and transfer them to Chip later as a directory move.
3. Delete the shell and keep only the FX core. That breaks every current user of `fx`.

**Recommendation: option 2.**
- `rust/fx-core` is the FX package (OD-9).
- All Zig code is relabeled as consumer code and may reach inference only through the boundary R4/R5 define for the Rust core. The core's own isolation is already enforced by `rust/fx-core/check-boundaries.sh` (no imports of product code, no ambient authority, dependency allowlist).
- The transfer to Chip becomes a later directory move with no semantic change.

**Blocks:** R5 scope (which commands survive) and R6 (release artifacts).

## OD-2: What interface does Easy-LLM offer, and in which language?

**Evidence.**
- No Easy-LLM code or interface exists in this workspace.
- FX's new core is a Rust crate with a std-plus-serde dependency allowlist (OD-9). The legacy product is pure Zig.
- Its embedding hosts are native, Node and browser.

**Options.**
1. Easy-LLM (the `rkendel1/llm` project) exposes a lower-level single-attempt API, and an explicit adapter implements `fx_core::Capability` over it.
2. Easy-LLM exposes a C ABI that FX wraps in a `Capability`.
3. Easy-LLM is a JavaScript or other-language library or service, reached through host adapters (N-API, WASM) or versioned local IPC.

**Recommendation.**
- FX defines `Capability`, the contract owner's prerogative under the brief. Easy-LLM implements it natively where it can (option 1).
- For JavaScript hosts, a JS implementation pushes contract events into the adapters (§4 C of [ARCHITECTURE.md](ARCHITECTURE.md)).
- Add local IPC only if Easy-LLM must run in its own process. If added, it carries exactly the contract JSON.

**Blocks:** R3. R1 and R2 do not depend on it; R2 uses the fake capability only. The single-attempt API must not silently invoke model fallback or duplicate routing policy, and FX never calls the high-level `llm()` function.

## OD-3: Where does the N-API addon get its capability?

**Evidence.**
- Today's addon gets its stream through a host fetch bridge (`napi_fetch_state.zig`, all 12 SDK scripts pass).
- It also makes native HTTP calls to Vercel for the catalog, credits and web search (`napi_core_main.zig:438-443`).

**Options.**
1. Link a native Easy-LLM capability into `libfx.node`.
2. Accept a host-provided JS capability and bridge its events through a generalized fetch-state machine.
3. Both.

**Recommendation.**
- Ship option 2 first. It removes all native networking from the addon, matches today's proven bridge, and does not wait on a native Easy-LLM.
- Add option 1 when OD-2 resolves to a native capability.

**Blocks:** R4.

## OD-4: Who owns permission policy: Chip or Attn?

**Evidence.**
- `src/core/permissions/*` mixes three things: tool admission mechanics, application-level authority, and sandbox enforcement.
  - Tool admission mechanics: rules, fingerprints, approval request IDs.
  - Application-level authority: who may approve, plus the model-based reviewer (`auto_classifier.zig`).
  - Sandbox enforcement: `sandbox.zig`.
- The brief assigns "application-level authority and control" to Attn and "tools" to Chip.

**Recommendation.**
- Attn owns approval authority: grants, rules, and the meaning of an approval request ID.
- Chip owns admission mechanics and calls Attn.
- Compute owns sandbox enforcement.

FX is unaffected either way, since it neither admits nor executes. This is recorded here because the brief requires one clear owner per capability.

**Blocks:** nothing in FX. It does block the Chip/Attn transfer of `AGT-PERM`.

## OD-5: Which WASM ABI: reactor push/poll, or JSPI-suspending imports?

**Evidence.**
- Today's modules are WASI commands. They need JSPI, which means Node 24 or a flag, and Chrome or Edge 137+ (`sdk/README.md`).
- They import an HTTP stream from the host (`js_host_stream_provider.zig`).
- Inference events come from the host in every target mode ([ARCHITECTURE.md](ARCHITECTURE.md) §7).

**Options.**
1. A reactor module where the host pushes capability events and polls normalized output. There are no suspending imports and no WASI.
2. Keep a command module with JSPI-suspending `fx_capability_*` imports.

**Recommendation: option 1.**
- It removes the JSPI requirement and the WASI shim.
- It satisfies "WASM must not assume filesystem, sockets, threads".
- It runs in any WebAssembly host.
- The cost is that the host drives the loop, which a small JS helper in `libfx` does.

**Status:** the reactor ABI (option 1) is adopted as the R4 design in RUST_PRIMITIVES.md §10; R1 already builds the contract for `wasm32-unknown-unknown`.

**Blocks:** R4.

## OD-6: Where is the rebuilt FX published, and under which names?

**Evidence.**
- `AGENTS.md` mandates `vercel-labs/fx` as canonical, and `sdk/package.json` points to it.
- This work happens in the fork `rkendel1/fx`.
- The npm name is `libfx`.
- The removal of Vercel coupling raises whether the canonical repository, package name and attribution header (`HTTP-Referer`) stay.
- `LICENSE:179` ("Copyright 2025 Vercel, Inc.") must be preserved under Apache-2.0 regardless.

**Recommendation.**
- Do not rename anything until the owner decides.
- The rebuilt core needs no repository URL in code: the only one today is the attribution header, which moves to Easy-LLM or is removed.
- Package naming is a release decision for R6. The Rust crate is `publish = false` until then.

**Blocks:** R6.

## OD-7: How does the product keep working until an Easy-LLM capability exists?

**Evidence.**
- The shell's only inference backend today is the Gateway code.
- If the legacy path is deleted before Easy-LLM provides a capability, `fx` stops working.

**Options.**
1. Make consumer migration (R5) wait for Easy-LLM.
2. Wrap the existing Gateway client as a capability owned by consumer code, outside `rust/fx-core`. It keeps every current behavior and is deleted in R5 when the Easy-LLM capability replaces it.

**Recommendation: option 2, with two conditions.**
- The wrapper must not live in `rust/fx-core` or appear in its dependency graph.
- FX's own build and tests must not depend on it (BM-13).

This is not "retaining Vercel dependencies to avoid rewriting adapters": FX itself is Vercel-free from R1 onward (the boundary gate forbids HTTP clients and provider SDKs in the core). The wrapper only keeps the product usable during migration, and it carries a fixed removal milestone.

**Blocks:** R5 sequencing.

## OD-8: Should the normalizer reject or skip malformed capability events?

**Evidence.**
- Today, malformed SSE JSON lines are skipped and traced (`client.zig:2826-2830`).
- With typed events, the only malformed input is at the JSON adapter boundary.

**Recommendation.**
- Reject with `protocol_violation` (A-1). Silently skipping provider output is how proposals get lost.
- Easy-LLM's SSE adapter may keep skipping malformed *transport* lines before it produces typed events.
- This is recorded as an intentional behavior change (R-9).

**Status:** decided as recommended. In R1 the wire decoder already rejects unknown event tags and invalid enum values (`event_unknown_type`, `event_finish_unknown_reason` fixtures).

**Blocks:** R2.

## OD-9: Implementation language of the rebuilt core (decided: Rust)

**Evidence.**
- The legacy implementation is Zig 0.16 with no dependencies ([BASELINE.md](BASELINE.md)).
- [RUST_PRIMITIVES.md](RUST_PRIMITIVES.md) §2 laid out three options: keep Zig, replace the planned core with Rust, or maintain both.
- The project owner chose Rust in the R1 PR request ("Rust is the implementation language for the rebuilt FX inference core").

**Decision: option B.**
- Rust is the normative implementation of the contract and, from R2, the executor (`rust/fx-core`).
- The Zig implementation remains the behavioral oracle until R5. It is never a second supported production inference core.
- Option C (maintain both) is rejected: duplicated semantics and a permanent conformance burden.

**Consequences.**
- The planned Zig module `src/fx/` will not be created.
- Contract tests live in Rust. Oracle parity is checked by replaying shared fixtures (R2).
- Adds Cargo, a pinned toolchain (`rust-toolchain.toml`, 1.97.0), a lockfile, a dependency allowlist and a separate CI workflow (`rust-core.yml`). Existing Zig gates are unchanged.
- The Zig consumers will reach the Rust executor through a C-compatible boundary designed in R4/R5 (RUST_PRIMITIVES §11). That boundary is a new risk (R-18).

**Status:** decided. Implemented first in R1.

