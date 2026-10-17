# `fx ask` and `chip work`: contracts, gaps and a proposed opt-in route

Analysis and proposal only. Nothing here is implemented, and the Zig loop stays the only route for `fx ask`. The point of this document
is to settle, from the code as it is, what an explicit opt-in route from `fx ask` to `chip work` would have to do. The questions
are routing, compatibility, lifecycle, rollback and tests. It also records which decisions belong to the owner before any code is
written. It does not change any blocker in `retirement.json`; `zig-agent-loop` stays `blocked`.

Sources: fx at `9d5333c` (`src/core/cli/cli_ask.zig` unless another path is given) and chip-rs at `c14522a`
(`crates/chip-cli/src/software_work.rs` unless another path is given). Exit codes and argument refusals for `chip work` were also
checked against a `chip` binary built from that commit (`chip 0.1.0`). Line numbers are for those commits.

## Contracts side by side

| Question | `fx ask` (Zig) | `chip work` (Rust) |
| --- | --- | --- |
| What it is for | any prompt: answer, explore, edit; the model decides when it is done | a goal of one `--kind`: `change` (default; edit until tests pass), `verify` (tests pass unchanged), `inspect` (observe and answer). Chip, not the model, decides completion |
| Prompt | positional words joined by spaces, or stdin when stdin is not a TTY (8 MiB cap) | exactly one positional argument, at most 2000 bytes; no stdin |
| Provider | Vercel AI Gateway protocol; `AI_GATEWAY_API_KEY`, `VERCEL_OIDC_TOKEN`, fx login or stored key; `FX_GATEWAY_BASE_URL` loopback only | `openai-compatible` (default) or `anthropic`; `CHIP_PROVIDER`/`CHIP_MODEL`/`CHIP_ENDPOINT` or flags; keys from `CHIP_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`; a model is always required |
| Model | settings, `FX_MODEL` | `--model` or `CHIP_MODEL`, required |
| Config files | `.fx.json`, `~/.fx/settings.json` (+ workspace overrides) | none; environment and flags only |
| Required external tool | none | PAX (`$PAX_BIN` or `pax` on `PATH`); refused with exit 3 if absent, **even for `inspect`** (`local_environment.rs:96-103`) |
| Tools | full builtin set: files, `terminal`, web, MCP, skills, memory, subagents, `ask_user_question` | `project.list/search/read/write`, read-only `project.git.*`, `pax.test`, `project.observe`. No shell, web, MCP, skills, memory or subagents |
| Permission model | modes `auto` (default), `ask`, `yolo`; prompt on stderr only with a TTY; non-interactive approval needed means abort, exit 1 | none; each request is validated against the declared capabilities and fails closed. `--yolo`, `--auto`, `--prompt-permissions` refused (exit 2) |
| Step limit | `FX_MAX_AGENT_STEPS`, default unbounded; reaching it fails the turn (exit 1) | `--max-turns` (default 12) and `--max-executions` (default 8), each 1 to 50; `LimitReached`, exit 1 |
| Streaming | raw and terminal modes stream assistant text as it arrives; `--json` prints once at the end | never; one report after the run (human on stdout, or one JSON object with `--json`) |
| JSON | one line: `output`, `exit_code`, `model`, `session_id`, `steps` (tool starts), `tool_calls[{name,status,...}]`, optional `error`, `auth_failure`, `recovery` | one object: `answer`, `terminal_state`, `outcome_reason`, `verified`, `grounded`, `executions_by_capability`, counts, `pax{...}`, `audit{...}`, `exit_status`, and more |
| Exit codes (process) | 0 success; 1 for every failure (the surface collapses internal 1/130/143 to 1, `cli_surface.zig:684-687`); death by SIGINT/SIGTERM after re-raise | 0 verified; 1 not verified (blocked, limit, escalated, or an `inspect` answer that is grounded); 2 usage; 3 nothing run (config, PAX, first model call failed); 4 runtime failure or audit violation |
| `inspect` success | n/a | **never exits 0** (`Inspect => false` for verified, `:152-158`); the best case is exit 1 with a grounded answer |
| Cancellation | SIGINT/SIGTERM handler; cancel flag checked between phases and passed into the loop; handler restored and the signal re-raised, so the process dies by the signal | no handler in `chip-cli`; the process dies by the default action. The `RunControl` cancel hook exists but `chip work` passes `control: None` (`:1690`) |
| Persistence | session under `~/.fx/sessions/<id>/` (`session.json`, `events.jsonl`) unless `--no-save`; store failure on a fresh run warns and continues | **none**. `chip-cli` does not depend on `chip-session` or `chip-turns`; the only lasting effects are project file writes. No resume |
| Resume and recovery | `--resume last|<id>`, `--resume-id`, `--continue-recovery` | refused (exit 2); an interrupted run must be asked again, and re-running may repeat effects (`release-limitations.md`) |
| Images, system prompt, timeout | `--image`, `--system`, `--timeout` | none (`--image` refused) |

## What that means for routing

A transparent switch, where `fx ask "<prompt>"` silently runs `chip work` instead, is not achievable with today's `chip work`. Five
of the differences above change what a user or script observes:

1. **The success signal differs.** An `inspect` run that answers correctly exits 1. A `change` run exits 0 only when PAX reports
   the tests passing after the last write. Scripts that test `fx ask`'s exit status would read a correct answer as a failure.
2. **PAX is a hard prerequisite.** Every `chip work` run, including read-only inspection, refuses to start without PAX.
3. **Credentials do not overlap.** `fx ask` users hold gateway credentials; `chip work` reads none of them.
4. **Nothing is saved.** A routed run has no session, so `session_id` would be empty and `--resume` could not apply.
5. **The tool surface is much smaller.** Prompts that need a shell, the web, MCP, skills or memory end as failed: the model's
   request is an undeclared capability.

The proposal below is therefore an explicit experiment, not a replacement.

## Proposed opt-in route (for review, not implemented)

**Routing.**

* Selected only by an explicit flag: `fx ask --executor chip --kind inspect|change|verify "<goal>"`.
  * The default executor stays `zig`.
  * There is no environment variable or settings key in the first version, so no ambient configuration can switch a user's
    route by surprise.
  * `--kind` is required with `--executor chip` and refused without it.
* The `chip` binary is found through `FX_CHIP_BIN` (an absolute path), else `chip` on `PATH`. It is spawned with the workspace root
  as its working directory.
* Invalid configuration is refused before anything runs, with `fx ask: --executor chip: <reason>` on stderr (or a JSON error
  object with `--json`) and exit 1. The cases:
  * an unknown executor value;
  * `--kind` without `--executor chip`, or a missing or unknown kind;
  * a binary that cannot be found or does not report a `chip` version;
  * any flag in the next paragraph.
* Flags refused on the chip route, because they have no meaning there: `--resume`, `--resume-id`, `--continue-recovery`, `--image`,
  `--system`, `--timeout`, `--auto`, `--yolo`, `--prompt-permissions`. A prompt from stdin, or one longer than 2000 bytes, is also
  refused rather than truncated.

**Compatibility.**

* Arguments map one to one:
  * the joined prompt becomes the goal;
  * `--kind` and `--json` pass through.
* Provider settings are not translated. The chip route reads only `CHIP_*` and the provider key variables, and that is documented.
  Mapping fx gateway credentials onto an OpenAI-compatible endpoint is an open decision (below), not part of the first version.
* `--json` output keeps fx's top-level fields:
  * `output` = Chip's `answer`, or empty;
  * `exit_code` = the fx process code;
  * `model` = Chip's `model`;
  * `session_id` = `""`;
  * `steps` = total executions;
  * `tool_calls` = one `{name: <capability>, status: "success"}` per execution.
* The `--json` output adds one new field, `chip`, carrying Chip's full report unchanged. Nothing is lost, and consumers can read
  `terminal_state`, `verified` and Chip's own `exit_status`.
* Text mode prints Chip's human report as is. Output is not streamed on this route, and the help text says so.
* Exit status follows fx's two-value surface: 0 when Chip exits 0, else 1. Chip's own code is preserved in `chip.exit_status`.
  This keeps `inspect` at 1. Whether a grounded `inspect` answer should map to 0 is an open decision.

**Lifecycle.**

* Cancellation: fx installs its usual headless handler. On SIGINT or SIGTERM it forwards the same signal to the `chip` child, waits
  for it, then restores the handler and re-raises, so the process dies by the signal as it does today. Neither side reports
  completion. A file write Chip had already made stays, as on the Zig route.
* Session state: the chip route behaves as `--no-save` and writes nothing under `~/.fx/sessions/`. No session is created, resumed
  or modified.
* Completion evidence is Chip's report (`terminal_state`, `verified`, `audit`), surfaced unchanged in `chip`. No fx turn or event
  log claims the run.

**Rollback.** Removing `--executor chip` from the command line returns to the Zig loop exactly. The route stores no state, writes no
session and changes no settings, so there is nothing to migrate or lose. Deleting the route's code later is self-contained:

* the flag parsing;
* one branch before `process_queued_prompt` (`cli_ask.zig:1626`);
* the spawn helper;
* its tests.

**Tests.**

* Unit tests in `cli_ask.zig` (the existing `RunDeps` and process seams):
  * the default route never spawns `chip`;
  * every refused flag and every invalid value exits 1 with its message, in text and JSON;
  * JSON mapping from a captured Chip report;
  * exit-code mapping for each Chip code 0 to 4.
* An E2E test with a stub `chip` (a script printing a fixed report and exit code) proves the spawn, the working directory, signal
  forwarding and the unchanged default route without Rust or PAX in the fx CI. It needs a classification in
  `scripts/pgso/corpus.json`; verification-only is the likely fit.
* A real-binary run belongs in the `agent-parity` workflow, which already builds `chip` and PAX.

**Placement.**

* The executor choice belongs to `src/core/cli/cli_ask.zig`, the command front end, not `src/core/agent`.
* The spawn helper belongs beside it or under `src/core/execution/`.
* The help text belongs in `src/builtins/commands.zig`, where `fx ask`'s usage lives today.
* Nothing under `src/core/agent` changes.

## Decisions for the owner before implementation

1. **Is the flag name and the required `--kind` acceptable?** The alternative is to infer a kind, which this document argues against:
   a wrong guess either edits files or reports a correct answer as a failure.
2. **Should a grounded `inspect` answer map to exit 0 on the fx surface?** This proposal keeps Chip's meaning (exit 1, "not
   verified") and exposes `chip.exit_status`.
3. **PAX for `inspect`:** accept that read-only inspection needs PAX, or change chip-rs so `inspect` does not locate PAX. The second is
   a chip-rs change, outside this repository.
4. **Credentials:** keep the chip route on `CHIP_*` only (proposed), or map fx gateway credentials to an OpenAI-compatible gateway
   endpoint. The second needs its own check that the gateway serves that protocol for the chosen models.
5. **No persistence:** accept that routed runs are unsaved (proposed), or wait for `chip-turns` in the shipped binary.

## Found while mapping (chip-rs, not fixed here)

These are chip-rs documents that disagree with chip-rs code. This repository cannot change them; they are recorded so the route's
docs do not repeat them.

* `docs/product/release-limitations.md:56` and `authoritative-fx.md:142` say the native provider has no proxy or custom-CA support. The
  code implements `CHIP_PROXY*` and `SSL_CERT_FILE` (`chip-cli/src/provider_selection.rs:211-290`).
* `docs/product/production-boundary.md:157,188` names `fx-provider-http`; the code uses `chip-fx-native`.
* `chip work --executor legacy` is refused with exit 3, not the usage code 2 (`provider_selection.rs:55-94`).

Found in fx's own `ask` front end:

* `--system`, `--timeout` and `--verbose` are accepted but undocumented.
* `--verbose` is never read.
* An invalid `--timeout` value is silently ignored.
* A missing value for `--image`, `--system` or `--timeout` reports "missing prompt".

These are separate fixes, not part of the route.
