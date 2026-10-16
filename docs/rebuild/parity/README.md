# Agent-loop parity

Evidence for the `zig-agent-loop` retirement gate: the same scripted scenarios, run through the Zig `fx ask` loop and Rust Chip, compared on **observable behavior only** (terminal state, answer, number of inference requests, tool executions, whether the tool result reaches the next request, side effects). Not compared: internals, event shapes, prompts.

| File | Role |
| --- | --- |
| `agent-loop.v1.json` | the versioned corpus: scenarios, what is compared, every *declared* difference with a class and a reason, owner `approvals`, and the behaviors the corpus does not cover (`unsupported_behaviors`) |
| `agent_parity.py` | `run` (needs both binaries), `check` (validates a stored result, no binaries), `diff` (two results must agree) |
| `openai_gateway.py`, `../tools/scripted_gateway.py` | scripted loopback model endpoints for the Rust and Zig sides |
| `test_agent_parity.py` | the harness's own tests: an undeclared difference is flagged, a declared one that did not occur is an error |
| `../evidence/agent-parity.json` | the committed result, produced from a fresh run |
| `../../../.github/workflows/agent-parity.yml` | builds both sides and requires the run to agree with the committed result |

```
cargo build -p chip-cli --bin chip -p chip-session --example session_tool -p chip-turns --example turn_tool   # in chip-rs
python3 docs/rebuild/parity/agent_parity.py run --chip-bin .../chip --turn-tool .../turn_tool --session-tool .../session_tool
python3 docs/rebuild/parity/agent_parity.py check
```

## Classification

A difference is never accepted by the runner. It must be written in the corpus as one of: `defect` (fix it), `intentional_change_requires_approval` (a recorded owner decision in `approvals` as `"<scenario>.<field>": "approved"`), `limitation` (a genuine limit that must be accepted or closed), or `unsupported` (not implemented or not drivable on the Rust side). A declared difference that does not occur is also an error, so the corpus cannot drift.

## Gate

* `run_is_valid`: no undeclared or stale difference and no scenario that failed to run.
* `retirement_ready`: valid **and** every difference approved **and** `unsupported_behaviors` empty. Today it is **false**, on purpose.

## What the first run found (Zig 0.0.4 prebuilt binary, Rust Chip at chip-rs `17a261a`)

Matches: basic turn, tool round trip (the same single read, result reaches the next request), HTTP 400 (not retried by either), step limit (2 requests, 2 reads, not completed), cancellation by SIGINT (both die with nothing reported complete and no tool run).

Differences, all classified, none approved yet:

* **D1 retries.** On 429, 500, a cut stream, and a 500 after a tool ran, Zig repeats the request and completes; Chip makes one request and surfaces the failure. In `failure_after_tool` the tool ran once on both sides.
* **D3 fail closed.** An unknown tool or a denied shell command is not executed by either side; Zig tells the model and continues, Chip ends the work as failed.
* **Zig writes outside the workspace.** With a fresh HOME and no flags, Zig's `write_file` with a `../` path executes (status success) and the file appears outside the workspace. Chip refuses the path before any execution. This looks like a permission-policy hole in Zig and deserves a separate security review.
* **Recovery.** After a kill mid-turn, Zig can resume the paused model response (`--continue-recovery`). Chip drops the uncommitted turn; the user must ask again, and re-running re-executes the capability (nothing is replayed automatically, but there is no idempotence guard). The shipped `chip` binary does not persist turns at all; only the `chip-turns` library and its example driver do.
* **Persistence failure.** Zig warns and still answers without saving; Chip refuses to run the turn.

## Approvals

Only reviewed differences are approved (`approvals` and `approval_record` in the corpus). Approved on 2026-10-16 by the repository owner: Chip fails closed on an unauthorized tool; Chip makes one attempt and surfaces provider failure (no implicit retry); Chip refuses writes outside the workspace; Chip refuses to run a turn when required persistence fails. These approve the *intended behavior*, not the absence of bugs. **Deliberately not approved:** `recovery_after_kill.resumes_the_interrupted_model_response` and `recovery_after_kill.side_effects_replayed_on_rerun`; crash recovery, replay of side effects and post-execution publication failure are safety questions, not cosmetic differences.

## Unsupported behaviors by release impact

| Category | Behaviors | What it needs |
| --- | --- | --- |
| `safety_correctness` | cancel between tool and next request; publication failure after the work ran; interactive permission prompts; no idempotence guard after a crash | an explicit design decision each, before the Zig loop can retire |
| `core_runtime` | provider-native/parallel tool calls; silent-tool continuation; pause/continue at the step limit | a clear supported or unsupported contract; not necessarily an implementation |
| `product_surfaces` | images; subagents, MCP, skills, memory, web | a supported/unsupported contract for the first Rust release |
| `compatibility` | permission modes | may not be needed for the first Rust release |

## Not covered (and so not claimed)

`unsupported_behaviors` lists what this corpus does not exercise or Rust does not implement: permission modes, provider-native and parallel tool calls, silent-tool continuation, pause/continue at the step limit, images, subagents/MCP/skills/memory/web, interactive approval, cancellation between a tool result and the next request, and a publish failure *after* the work ran. A passing run over this corpus is **not** a claim that the loop is ready to retire.

Cancellation is process death on both sides (SIGINT); neither has a graceful in-process cancel at the CLI. Real PAX was not needed for these scenarios.

The committed result was produced with the prebuilt `zig-out/bin/fx` found in this checkout (reports 0.0.4), not a fresh `zig build`; the workflow builds it fresh and must agree. That workflow had not run when this was written.
