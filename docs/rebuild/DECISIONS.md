# Open decisions

These questions are still open and each one changes the architecture or the PR sequence. Each entry gives the evidence, the options, and a recommendation. Nothing in this PR depends on the answers. The roadmap marks the PR that each decision blocks.

## OD-1: What happens to the product shell and the in-repo agent loop?

**Evidence.**
- 303 files and about 346,000 lines are classified `fx-shell`.
- About 318 files and 355,000 lines are classified as Chip-owned behavior ([inventory/summary.md](inventory/summary.md)).
- Chip is not present in this workspace ([BASELINE.md](BASELINE.md), "Consumers").
- The brief puts Chip in charge of the agent loop. It also rules out rebuilding Chip in this program.
- The CLI/TUI has no assigned owner.

**Options.**
1. Move the agent loop and shell to Chip now. This cannot be verified here, because Chip's code is unavailable.
2. Keep both in this repository as consumer #1 of the new `src/fx` module. Enforce the module boundary mechanically, and transfer them to Chip later as a directory move.
3. Delete the shell and keep only the FX core. That breaks every current user of `fx`.

**Recommendation: option 2.**
- `src/fx/` becomes the FX package.
- All other code is relabeled as consumer code and may reach inference only through `src/fx`'s public API. An import-boundary check enforces this: no file under `src/fx/` imports outside `src/fx/` and `src/core/shared/io.zig`, and no file outside `src/fx/` imports `src/fx/` internals.
- The transfer to Chip becomes a later directory move with no semantic change.

**Blocks:** PR 5 scope (which commands survive) and PR 6 (release artifacts).

## OD-2: What interface does Easy-LLM offer, and in which language?

**Evidence.**
- No Easy-LLM code or interface exists in this workspace.
- FX today is pure Zig with zero dependencies.
- Its embedding hosts are native, Node and browser.

**Options.**
1. Easy-LLM implements `fx.contract.Capability` in Zig and links into native builds.
2. Easy-LLM exposes a C ABI that FX wraps in a `Capability`.
3. Easy-LLM is a JavaScript or other-language library or service, reached through host adapters (N-API, WASM) or versioned local IPC.

**Recommendation.**
- FX defines `Capability`, the contract owner's prerogative under the brief. Easy-LLM implements it natively where it can (option 1).
- For JavaScript hosts, a JS implementation pushes contract events into the adapters (§4 C of [ARCHITECTURE.md](ARCHITECTURE.md)).
- Add local IPC only if Easy-LLM must run in its own process. If added, it carries exactly the contract JSON.

**Blocks:** PR 3. PR 1 and PR 2 do not depend on it, because they use the fake capability only.

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

**Blocks:** PR 4.

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

**Blocks:** PR 4.

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
- Package naming is a release decision for PR 6.

**Blocks:** PR 6.

## OD-7: How does the product keep working between PR 3 and the arrival of an Easy-LLM capability?

**Evidence.**
- The shell's only inference backend today is the Gateway code.
- If PR 3 deletes it before Easy-LLM provides a capability, `fx` stops working.

**Options.**
1. Make PR 3 wait for Easy-LLM.
2. In PR 3, wrap the existing Gateway client as a capability owned by consumer code (`src/shell/legacy_gateway_capability.zig`). It stays outside `src/fx`, keeps every current behavior, and is deleted in PR 5 when the Easy-LLM capability replaces it.

**Recommendation: option 2, with two conditions.**
- The wrapper must not live in `src/fx`.
- FX's own build and tests must not depend on it (BM-13).

This is not "retaining Vercel dependencies to avoid rewriting adapters": FX itself is Vercel-free from PR 2 onward. The wrapper only keeps the product usable during migration, and it carries a fixed removal milestone.

**Blocks:** PR 3 sequencing.

## OD-8: Should the normalizer reject or skip malformed capability events?

**Evidence.**
- Today, malformed SSE JSON lines are skipped and traced (`client.zig:2826-2830`).
- With typed events, the only malformed input is at the JSON adapter boundary.

**Recommendation.**
- Reject with `protocol_violation` (A-1). Silently skipping provider output is how proposals get lost.
- Easy-LLM's SSE adapter may keep skipping malformed *transport* lines before it produces typed events.
- This is recorded as an intentional behavior change (R-9).

**Blocks:** PR 2.
