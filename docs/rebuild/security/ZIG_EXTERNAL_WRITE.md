# Security review: Zig `write_file` creates files outside the workspace without review

Status: **open, unreviewed.** Found while running the agent-loop parity corpus (`docs/rebuild/parity/`). Rust Chip refuses the same request; its stricter behavior is kept and must not be weakened to match. This document records what was observed, not a verdict or a severity rating.

## Summary

With no flags and a fresh `HOME` (the default permission mode), the Zig `fx ask` loop executed a model-requested `write_file` that **creates a new file outside the workspace** (an absolute path, or a `../` path) with status `success`, and **no permission review took place**. Every other file-mutating tool tested on an outside path, and `write_file` when it would *overwrite* an existing outside file, was routed to the auto-mode reviewer (a `permission_decision` model call) before acting.

## Reproduction

`python3 docs/rebuild/security/repro_external_mutation.py --fx-bin <fresh build of this checkout>`. It uses a throwaway directory for both the workspace and the "outside" area, a scripted loopback model (no credentials, no network), and touches nothing outside that directory. It reports, per tool, whether the reviewer was invoked and whether the effect happened. The scripted endpoint never answers the reviewer validly, so any reviewed action is denied (fail closed); an action that never reaches the reviewer is "exposed".

Observed with the prebuilt `zig-out/bin/fx` that reports `0.0.4` (rows are the script's own output):

| Case (outside the workspace) | Reviewer invoked | Effect happened |
| --- | ---: | --- |
| `write_file` creating a **new** file (absolute path) | 0 | **yes** |
| `write_file` creating a new file via `../` | 0 | **yes** |
| `write_file` overwriting an existing file | 1 | no |
| `edit_file` | 1 | no |
| `delete_file` | 1 | no |
| `create_folder` | 1 | no |
| `copy_file` | 1 | no |
| `rename_file` | 1 | no |

Earlier ad-hoc runs (same binary) also showed new-file creation succeeding with `--auto`, `--yolo` (expected: yolo disables checks) and `--prompt-permissions`, and at absolute targets under `/tmp`, the user's home directory and `/etc` (the process was root in that sandbox, so the last one says nothing about OS permissions).

## Affected path handling (from reading the source, not from a rebuilt binary)

* `src/core/permissions/permissions.zig`: `external_path_tools` lists `write_file`, `edit_file`, `delete_file`, `create_folder`, `copy_file`, `rename_file` and the read tools as tools that may address paths outside the workspace; `resolveFileToolPath` then uses `resolveWorkspaceOrExternalCreatePath` for `write_file`. External targets are an intended feature, gated by permission policy.
* `src/core/config/config_runtime.zig`: `default_permission_mode = .auto` (an LLM reviewer decides unresolved requests).
* `src/core/workspace/context_contract.zig` states that, non-interactively, approval-required actions fail with a blocker instead of prompting. The observed new-file `write_file` neither blocked nor reached the reviewer, so either it is classified as not approval-required, or the shipped binary differs from this source. **Not determined.**

## Reachability

Reachable from the default mode of the shipped binary as observed, by anything that can cause the model to emit a `write_file` tool call (a prompt-injected file or web page, a malicious dependency README, a compromised provider). No user interaction was needed in the non-interactive `ask` path. The interactive TUI, ACP and gateway surfaces were **not** tested and may differ.

## Impact (potential)

The loop can create a file at any path the user account can write, without review: for example a new file in an autoload directory (`~/.config/*/conf.d`, shell rc drop-ins, `~/.ssh/authorized_keys` if absent), a git hook in another repository, or a file that shadows something earlier on a search path. It cannot, by this route, overwrite or delete an existing file (those were reviewed). Whether the impact is serious depends on whether the creation is deliberately considered low risk; that is the question for the review.

## Not tested

Symlinked directories inside the workspace pointing outside; a path whose parent is created by the same call; races between the check and the write; the TUI, ACP, gateway and subagent paths; behavior when the reviewer *approves*; Windows/macOS path semantics.

## Limits of this evidence

The binary is the prebuilt `zig-out/bin/fx` in the checkout. Zig was not available in the environment where this was written, so it was **not rebuilt** and the correspondence between that binary and the current source is unverified. Re-run the script against a fresh `zig build` before treating any row as established. No Zig test was run.

## Suggested follow-ups (not implemented here)

1. Reproduce with a fresh build; if confirmed, decide whether new-file creation outside the workspace is meant to need review.
2. If not meant to be exempt: route it through the same review as overwrite/edit, with a regression test in the Zig suite and a row in this script that must report `reviewer_invoked >= 1` or `effect_happened=False`.
3. Audit the TUI/ACP/gateway paths and symlink cases.
4. Rust Chip keeps refusing outside paths; do not relax it for parity (owner decision, 2026-10-16).
