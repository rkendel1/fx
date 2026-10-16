# FX forensic decomposition and clean-room rebuild plan

This directory holds the architecture discovery and the rebuild plan for turning FX into a small, provider-neutral inference core without Vercel dependencies.

## Status

| Step | State | Where |
| --- | --- | --- |
| R0 decomposition and language decision | Done. Rust is the implementation language (OD-9); the Zig code under `src/` is the behavioral oracle until R5 | this directory, [RUST_PRIMITIVES.md](RUST_PRIMITIVES.md), [DECISIONS.md](DECISIONS.md) |
| R1 contract crate | Implemented | [`rust/fx-core`](../../rust/fx-core), test map in [BEHAVIOR_MATRIX.md](BEHAVIOR_MATRIX.md) §8, gates in `.github/workflows/rust-core.yml` |
| R2–R6 | Planned | [ROADMAP.md](ROADMAP.md) |

The decomposition documents changed no product code. R1 adds the Rust crate and its CI workflow; it does not touch any Zig source, product caller, public API, npm package or existing workflow.

Audited commit for the decomposition: `255c6cf125034baad48c99bd618783d63dab7df1` ([BASELINE.md](BASELINE.md)).

## Documents

| # | Required artifact | Where |
| --- | --- | --- |
| 1 | FX inventory: every in-scope file with purpose, classification and review status | [inventory/files.tsv](inventory/files.tsv) (848 rows at R1: the 784 audited files plus the R1 additions), totals in [inventory/summary.md](inventory/summary.md) |
| 2 | Method inventory: every production method and public type with behavior, dependencies, callers, tests and disposition | [inventory/symbols.tsv](inventory/symbols.tsv) (23,967 declarations, about 4.4 MB; open raw), curated refinements in [inventory/symbol_overrides.tsv](inventory/symbol_overrides.tsv), behavior in [audit/](audit/) |
| 3 | Dependency report, including all Vercel-specific paths | [VERCEL_TRACE.md](VERCEL_TRACE.md) §1-3 |
| 4 | Capability ledger | [CAPABILITIES.md](CAPABILITIES.md) |
| 5 | Current architecture diagram | [ARCHITECTURE.md](ARCHITECTURE.md) §2 |
| 6 | Target architecture diagram | [ARCHITECTURE.md](ARCHITECTURE.md) §6 |
| 7 | Primitive specifications | [ARCHITECTURE.md](ARCHITECTURE.md) §4, §8-11 |
| 8 | Behavior-preservation matrix | [BEHAVIOR_MATRIX.md](BEHAVIOR_MATRIX.md) |
| 9 | Risk register | [RISKS.md](RISKS.md) |
| 10 | Implementation roadmap | [ROADMAP.md](ROADMAP.md) |
| 11 | Removal ledger | [VERCEL_TRACE.md](VERCEL_TRACE.md) §4 |
| 12 | Open decisions | [DECISIONS.md](DECISIONS.md) |
| — | Rust primitive design (normative language and crate plan) | [RUST_PRIMITIVES.md](RUST_PRIMITIVES.md) |
| — | Rust contract implementation (R1) | [`rust/fx-core`](../../rust/fx-core) |
| — | Phase A baseline | [BASELINE.md](BASELINE.md) |
| — | Observed wire behavior of the built binary | [evidence/observed-wire.md](evidence/observed-wire.md) |
| — | Subsystem audits with file:line evidence | [audit/01-inference-path.md](audit/01-inference-path.md), [02-auth-config-hosts](audit/02-auth-config-hosts.md), [03-agent-tools-execution](audit/03-agent-tools-execution.md), [04-embedding-build-ci](audit/04-embedding-build-ci.md), [05-product-shell](audit/05-product-shell.md) |

## Headline findings

1. **Vercel coupling lives in protocols, not packages.** The repository has no Vercel AI SDK package. FX implements Vercel AI Gateway's AI SDK `LanguageModelV3` protocol natively in Zig, and also carries Sign in with Vercel, the Gateway catalog, credits, billing reconciliation, Vercel Sandbox and a Vercel Blob CDN ([VERCEL_TRACE.md](VERCEL_TRACE.md)).
2. **`ModelProvider.chat(ChatRequest) → ChatStream` does not exist.** The real seam is `stream_provider.Provider{build_fn, stream_fn}` (`src/core/agent/stream_provider.zig:178`). It has the right shape, but credentials, endpoint, retry count, HTTP status and opaque wire bytes leak through it ([audit/01](audit/01-inference-path.md) §1).
3. **FX today is a whole agent product, not an inference library.**
   - The proposed FX core covers 74 files and about 44k lines.
   - About 355k lines are Chip behavior, about 75k Compute, about 16k Easy-LLM, and about 346k are the CLI/TUI shell, whose owner is undecided (OD-1).
4. **No embedding surface offers inference.** N-API, WASM and the npm SDK all expose an ACP agent server ([audit/04](audit/04-embedding-build-ci.md)).
5. **Three primitives are enough:**
   - a Contract (which also absorbs stream lifecycle and the capability interface)
   - an Executor (which also absorbs diagnostics)
   - Runtime Adapters

   They are implemented in Rust (`rust/fx-core`); the contract exists as of R1. See [ARCHITECTURE.md](ARCHITECTURE.md) §4.

## Method

- **Baseline.** I recorded commit, tree, toolchain, dependencies and surfaces, then built and ran the binary, the unit tests, the WASM core and the N-API addon in this container ([BASELINE.md](BASELINE.md)).
- **File inventory.** `tools/generate_inventory.py` lists every tracked file (`git ls-files`) except this directory. Each file is classified by the longest-prefix rule in `inventory/ownership_rules.tsv`, which assigns a capability, owner and disposition. Each file also has a review column naming the audit note that covered its area.
- **Declaration inventory.** A line scanner extracts every declaration that is not inside a test block:
  - Zig: `fn`, `struct`, `enum`, `union`, `opaque`, error sets, `pub const` and `pub var`
  - JavaScript: functions, classes, methods, exports

  Zig containers are qualified using `zig fmt`'s fixed indentation. Each declaration inherits its file's disposition unless `inventory/symbol_overrides.tsv` refines it; 224 inference-path declarations are refined this way.
- **Callers.** `external_ref_files` counts the other tracked files, in the same language family, whose identifier tokens include the symbol's name. Names defined in six or more files, or referenced from more than 40, are marked `ambiguous`. This is **lexical evidence**, not a resolved call graph. Before any symbol is moved or deleted, the Zig compiler's own resolution is the final check (R-16).
- **Tests.**
  - `tests` counts Zig `test` blocks, Bun/JS test cases (including the repository's `tmuxTest` / `serialTest` / `test.skipIf(...)` wrappers), Python `test_*` functions, and one scenario per standalone `sdk/tests/test-*.mjs` script.
  - `named_in_file_tests` says whether the declaration's name appears inside a test block in its own file.
- **Behavior.** Five read-only audit passes covered the inference path, auth/config/hosts, the agent/tools/execution stack, embedding/build/CI, and the product shell. Their key claims were then re-verified against source; ✓ marks these in the audit notes. On top of that, the built binary was driven against a loopback fake to observe the exact request and stream ([evidence/observed-wire.md](evidence/observed-wire.md)).
- **Checks.** `python3 docs/rebuild/tools/generate_inventory.py --check` fails in any of these cases:
  - the outputs are stale
  - any tracked file is unclassified
  - any file has no covering audit
  - any symbol override matches nothing
  - any capability ID is missing from [CAPABILITIES.md](CAPABILITIES.md)

## Disposition vocabulary

| Term | Meaning |
| --- | --- |
| KEEP | Essential capability with a sound boundary; carried over as is |
| REBUILD | Valuable behavior behind undesirable coupling; reimplemented in the new core or its adapters |
| MOVE | Valid behavior owned by another system (Easy-LLM, Chip, Compute, Attn); handed over with its tests |
| REMOVE | No required consumer, or Vercel-only behavior with no replacement; deleted with consumer-impact analysis in the removal ledger |
| INVESTIGATE | Evidence is insufficient or the owner is undecided; each such area points to an open decision |

## Scope and exclusions

- **In scope:** all 784 tracked files at the audited commit.
- **Not inventoried individually:** `docs/rebuild/` itself (this PR's output).
- **Grouped by origin, still listed in `files.tsv`:**
  - the generated Unicode tables (`src/core/shared/unicode_display_data.zig`)
  - binary assets (sound files in `src/core/notifications/`, the render fixture tarball under `tests/e2e/fixtures/`), marked `binary`
  - lockfiles
- **Test-local declarations** (helpers inside `test` blocks and in test-only files) are counted per file in `test_local_decls` but not listed one by one. They are not production methods.

Regenerate after any tree change:

```bash
python3 docs/rebuild/tools/generate_inventory.py
python3 docs/rebuild/tools/generate_inventory.py --check
```

Reproduce the wire evidence: see [evidence/observed-wire.md](evidence/observed-wire.md).

## Definition of done: status

| Item | Status | Evidence |
| --- | --- | --- |
| Every tracked file in scope is inventoried | Done | `files.tsv`, 848 rows (784 audited + R1 files); `--check` reports 0 unclassified and 0 unreviewed files |
| Every production method and public type is accounted for | Done, with lexical callers | `symbols.tsv`: every declaration has an owner and disposition. Caller evidence is lexical (see Method) |
| Public APIs, runtime surfaces and external consumers mapped | Done | [BASELINE.md](BASELINE.md) "Public surfaces" and "Consumers"; [audit/04](audit/04-embedding-build-ci.md). No Chip, Easy-LLM, Compute, Attn or PAX consumer exists in this workspace |
| Vercel and framework coupling traced to source and effects | Done | [VERCEL_TRACE.md](VERCEL_TRACE.md), 39 findings classified |
| Valuable behavior distinguished from accidental detail | Done | [ARCHITECTURE.md](ARCHITECTURE.md) §1 table; [CAPABILITIES.md](CAPABILITIES.md) |
| Each capability has an explicit target owner and disposition | Done; four owners are decisions | 58 capability IDs. `PRD-*`, `OPS-BENCH`, `OPS-PGSO` and `OPS-TEST-E2E` are INVESTIGATE pending OD-1 |
| Primitives have responsibilities and non-responsibilities | Done | [ARCHITECTURE.md](ARCHITECTURE.md) §4 |
| No duplicate provider, routing, credential or model-registry abstraction proposed | Done | FX defines only the `Capability` interface that Easy-LLM implements; §5 ownership table |
| Stream, cancellation, errors, lifecycle and metadata have explicit contracts | Done | §4 state machine and invariants I1-I10, §8 errors, §9 cancellation C1-C7 |
| Native and WASM requirements grounded in actual capabilities | Done | §7: only remote inference exists today. CPU and accelerated modes are not promised |
| Chip, Easy-LLM, Compute and Attn boundaries preserved | Done | §5-6; Attn and Compute have no edge into FX |
| Every retained behavior has a conformance test or a documented gap | Done (tests specified; implementation lands in R1-R2) | [BEHAVIOR_MATRIX.md](BEHAVIOR_MATRIX.md) §2-3, gaps §7 |
| All proposed removals have consumer-impact analysis | Done | [VERCEL_TRACE.md](VERCEL_TRACE.md) §4 |
| Roadmap has ordered, independently testable PRs | Done | [ROADMAP.md](ROADMAP.md) |
| Working code, APIs, dependencies and runtime behavior unchanged | Done | Diff touches only `docs/rebuild/` |
| No exhaustive-review claim while anything is unclassified | Holds | Every file and declaration has a recorded disposition. The ✓ re-verification covers key claims, not each of the 23,967 declarations line by line. That limit is stated here, not hidden |

Not verified in this environment, and therefore not claimed:
- E2E (Bun/tmux) and WASM SDK lanes were not run locally. They run in Full CI.
- Full CI has never run on this fork; R1 establishes that baseline (R-11).
- Live-credential suites were not run.

## Final review question

> Could another engineer use these artifacts to implement a fresh FX core without reading the existing implementation to guess its behavior, while knowing which capabilities must be preserved and which dependencies should disappear?

For the core itself: yes. [ARCHITECTURE.md](ARCHITECTURE.md) §4 gives the types, the state machine, the invariants and the error mapping. [BEHAVIOR_MATRIX.md](BEHAVIOR_MATRIX.md) gives the expected outcomes, each tied to an existing test name that proves the current behavior. [evidence/observed-wire.md](evidence/observed-wire.md) pins the observed request and stream.

Two things still require external input, and they are recorded as decisions rather than guessed:
- the concrete Easy-LLM interface (OD-2)
- the future owner of the product shell (OD-1)
