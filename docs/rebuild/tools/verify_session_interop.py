"""Interoperability of Rust Chip turns and the Zig `fx` over one durable session store.

Uses the real Zig binary and two drivers built from rkendel1/chip-rs:

  session_tool  (cargo build -p chip-session --example session_tool)
  turn_tool     (cargo build -p chip-turns   --example turn_tool)

Scenarios (each prints `ok`/`FAIL`; the exit status is non-zero on any failure):

  1  Zig creates a session; Rust reads it and persists a real turn.
  2  Rust creates a session; Rust persists a turn; Zig resumes it.
  3  Zig creates; Rust persists a turn; Zig resumes and continues.
  4  Rust reads the mixed log: order, sequence and identifiers are preserved.
  5  Interrupted Rust writes (a crash at every commit boundary) leave a session both implementations recover.
  6  Malformed and unsupported events are refused by Rust (and, where Zig has a contract, by Zig).
  7  Negative control: an intentionally incompatible event is rejected by both; the check fails if Zig accepts it.
  7b The control itself can fail: given a compatible event, the same check reports failures.

    python3 docs/rebuild/tools/verify_session_interop.py --session-tool PATH --turn-tool PATH [--bin ./zig-out/bin/fx]
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from scripted_gateway import text_stream  # noqa: E402

COMPLETE = json.dumps({"decision": "complete", "summary": "rust answer"})
REQUEST = json.dumps({"decision": "request_capability", "capability": "compute.selftest", "inputs": {"n": 3}})
STARTED = {
    "id": "",
    "created_at_ms": 1,
    "origin_workspace_root": "",
    "workspace_root": "",
    "conversation_language": "und-Latn",
    "preferences": {"model": "zai/glm-5.2", "effort": "auto", "fast_mode": False},
}
BOUNDARIES = ["after_event_append", "after_event_sync", "after_intent_sync", "after_watermark_rename", "after_intent_remove"]
failures: list[str] = []


def check(condition: bool, message: str) -> bool:
    print(("ok   " if condition else "FAIL ") + message)
    if not condition:
        failures.append(message)
    return condition


class Rig:
    def __init__(self, zig: Path, session_tool: Path, turn_tool: Path, tmp: Path):
        self.zig, self.session_tool, self.turn_tool = zig, session_tool, turn_tool
        self.home, self.workspace = tmp / "home", tmp / "ws"
        self.home.mkdir()
        self.workspace.mkdir()
        self.sessions = self.home / ".fx" / "sessions"
        self.tmp = tmp
        self.n = 0

    def dir(self, sid: str) -> Path:
        return self.sessions / sid

    def zig_ask(self, prompt: str, resume: str | None = None) -> subprocess.CompletedProcess:
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        script, log = self.tmp / "s.json", self.tmp / "l.jsonl"
        script.write_text(json.dumps([{"sse": text_stream(f"zig answer to {prompt}")}]))
        gateway = subprocess.Popen(
            [sys.executable, str(Path(__file__).parent / "scripted_gateway.py"), str(port), str(log), str(script)]
        )
        try:
            time.sleep(0.4)
            env = {
                **os.environ,
                "HOME": str(self.home),
                "AI_GATEWAY_API_KEY": "placeholder",
                "FX_GATEWAY_BASE_URL": f"http://127.0.0.1:{port}",
                "FX_GATEWAY_CHAT_URL": f"http://127.0.0.1:{port}/v3/ai/language-model",
            }
            args = [str(self.zig), "ask", "--json", "--yolo"] + (["--resume-id", resume] if resume else []) + ["--", prompt]
            return subprocess.run(args, cwd=self.workspace, env=env, capture_output=True, text=True, timeout=120)
        finally:
            gateway.kill()
            gateway.wait()

    def zig_new(self, prompt: str) -> str:
        done = self.zig_ask(prompt)
        if done.returncode != 0:
            raise SystemExit(f"FAIL zig could not create a session: {done.stderr[-300:]}")
        return json.loads(done.stdout.strip().splitlines()[-1])["session_id"]

    def rust_new(self, name: str) -> str:
        payload = dict(STARTED, id=name, origin_workspace_root=str(self.workspace), workspace_root=str(self.workspace))
        done = subprocess.run([str(self.session_tool), "create", str(self.sessions), name], input=json.dumps(payload, separators=(",", ":")), capture_output=True, text=True)
        if done.returncode != 0:
            raise SystemExit(f"FAIL rust could not create a session: {done.stderr}")
        return name

    def turn(self, sid: str, prompt: str, replies: list[str] | None = None, crash: str | None = None) -> subprocess.CompletedProcess:
        self.n += 1
        path = self.tmp / f"replies{self.n}.json"
        path.write_text(json.dumps(replies or [REQUEST, COMPLETE]))
        env = {**os.environ, **({"CHIP_SESSION_CRASH": crash} if crash else {})}
        return subprocess.run([str(self.turn_tool), "run", str(self.dir(sid)), str(path), prompt], capture_output=True, text=True, env=env)

    def history(self, sid: str) -> tuple[int, dict | None, str]:
        done = subprocess.run([str(self.turn_tool), "history", str(self.dir(sid))], capture_output=True, text=True)
        return done.returncode, (json.loads(done.stdout) if done.returncode == 0 else None), done.stderr.strip()

    def append_raw(self, sid: str, kind: str, payload: str) -> subprocess.CompletedProcess:
        return subprocess.run([str(self.session_tool), "append-raw", str(self.dir(sid)), kind], input=payload, capture_output=True, text=True)


def turns(history: dict) -> list[str]:
    return [t["user"] for t in history["turns"]]


def contiguous(history: dict) -> bool:
    seqs = [e["seq"] for e in history["events"]]
    return seqs == list(range(1, len(seqs) + 1))


def scenario_1(rig: Rig) -> None:
    print("-- 1: Zig creates; Rust reads and persists a turn")
    sid = rig.zig_new("zig first")
    _, before, _ = rig.history(sid)
    done = rig.turn(sid, "rust follow-up")
    check(done.returncode == 0 and json.loads(done.stdout)["persistence"] == "committed", "Rust persisted a real turn into a Zig-created session")
    rc, after, err = rig.history(sid)
    check(rc == 0 and turns(after) == ["zig first", "rust follow-up"], f"Rust reloads both turns in order {err}")
    check(after["events"][: len(before["events"])] == before["events"], "Zig's events are untouched (same sequence numbers and ids)")
    rust_turn = after["turns"][1]
    check(rust_turn["assistant"] == "rust answer" and rust_turn["tool_calls"] == ["compute.selftest"], "the Rust turn recorded its answer and its authorized tool call")


def scenario_2(rig: Rig) -> None:
    print("-- 2: Rust creates; Rust persists a turn; Zig resumes")
    sid = rig.rust_new("rust-origin")
    done = rig.turn(sid, "rust first")
    check(done.returncode == 0, "Rust persisted a turn into a Rust-created session")
    resumed = rig.zig_ask("zig second", sid)
    check(resumed.returncode == 0 and json.loads(resumed.stdout.strip().splitlines()[-1])["session_id"] == sid, f"Zig resumed the Rust-created session and ran a turn {resumed.stderr[-200:]}")
    rc, history, err = rig.history(sid)
    check(rc == 0 and turns(history) == ["rust first", "zig second"], f"the log holds both writers' turns in order {err}")


def scenario_3_and_4(rig: Rig) -> None:
    print("-- 3: Zig creates; Rust persists; Zig resumes and continues")
    sid = rig.zig_new("zig one")
    check(rig.turn(sid, "rust two").returncode == 0, "Rust persisted a turn")
    resumed = rig.zig_ask("zig three", sid)
    check(resumed.returncode == 0, f"Zig resumed after Rust's turn and continued {resumed.stderr[-200:]}")
    print("-- 4: Rust reads the mixed log")
    rc, history, err = rig.history(sid)
    check(rc == 0 and turns(history) == ["zig one", "rust two", "zig three"], f"turn order is preserved across writers {err}")
    check(contiguous(history), "sequence numbers are contiguous across writers")
    ids = [e["event_id"] for e in history["events"]]
    check(len(set(ids)) == len(ids), "event identifiers are unique across writers")
    check(history["uncommitted_tail_bytes"] == 0 and not history["pending_recovery"], "no uncommitted tail and no pending recovery")


def scenario_5(rig: Rig) -> None:
    print("-- 5: interrupted Rust writes leave a recoverable session")
    for boundary in BOUNDARIES:
        sid = rig.zig_new(f"zig before {boundary}")
        crashed = rig.turn(sid, f"rust crashing at {boundary}", crash=boundary)
        check(crashed.returncode == 3, f"[{boundary}] the Rust writer died mid-commit (exit {crashed.returncode})")
        rc, mid, err = rig.history(sid)
        published = boundary in ("after_watermark_rename", "after_intent_remove")
        check(rc == 0 and len(mid["turns"]) == (2 if published else 1), f"[{boundary}] Rust reads only what was committed ({'turn published' if published else 'no falsely completed turn'}) {err}")
        resumed = rig.zig_ask(f"zig after {boundary}", sid)
        check(resumed.returncode == 0, f"[{boundary}] Zig recovered the session and continued {resumed.stderr[-200:]}")
        rc, final, err = rig.history(sid)
        expected = (3 if published else 2)
        check(rc == 0 and len(final["turns"]) == expected and contiguous(final) and final["uncommitted_tail_bytes"] == 0, f"[{boundary}] the recovered log is whole ({expected} turns, contiguous) {err}")


MALFORMED_TURN = json.dumps({"conversation_language": "und-Latn", "total_input_tokens": 1, "total_output_tokens": 1, "turn": {"kind": "assistant"}})
BAD_TOOL_RESULT = json.dumps(
    {
        "conversation_language": "und-Latn",
        "total_input_tokens": 1,
        "total_output_tokens": 1,
        "turn": {
            "kind": "assistant",
            "user": {"text": "x", "images": []},
            "assistant": "y",
            "execution": {
                "schema_version": 3,
                "tool_steps": [{"assistant": None, "tool_calls": [], "tool_results": [{"tool_call_id": "1", "tool_name": "n", "status": "success", "output": ""}]}],
                "files": [],
            },
        },
    }
)


def rejected_by_both(rig: Rig, label: str, kind: str, payload: str) -> None:
    sid = rig.zig_new(f"zig for {label}")
    appended = rig.append_raw(sid, kind, payload)
    check(appended.returncode == 0, f"[{label}] the incompatible event was written")
    rc, _, err = rig.history(sid)
    check(rc != 0, f"[{label}] Rust refuses the session ({err[:90]})")
    zig = rig.zig_ask("continue", sid)
    check(zig.returncode != 0, f"[{label}] Zig refuses it too (exit {zig.returncode})")


def scenario_6(rig: Rig) -> None:
    print("-- 6: malformed, foreign and unsupported events")
    rejected_by_both(rig, "malformed turn", "history_turn_committed", MALFORMED_TURN)
    sid = rig.zig_new("zig for unsupported")
    rig.append_raw(sid, "state_replacement_started", "{}")
    rc, _, err = rig.history(sid)
    check(rc != 0 and "unsupported" in err, f"[state_replacement] Rust reports it as unsupported rather than skipping it ({err[:90]})")
    sid = rig.zig_new("zig for pending recovery")
    rig.append_raw(sid, "recovery_checkpoint_set", '{"checkpoint":{"version":1}}')
    done = rig.turn(sid, "should not run")
    check(done.returncode != 0 and "unfinished turn" in done.stderr, "[pending recovery] Rust will not start a turn over an unfinished one")


def scenario_7(rig: Rig) -> None:
    print("-- 7: negative control")
    rejected_by_both(rig, "negative control: tool result missing keys", "history_turn_committed", BAD_TOOL_RESULT)


VALID_TURN = json.dumps(
    {
        "conversation_language": "und-Latn",
        "total_input_tokens": 1,
        "total_output_tokens": 1,
        "turn": {"kind": "assistant", "user": {"text": "x", "images": []}, "assistant": "y", "execution": {"schema_version": 3, "tool_steps": [], "files": []}},
    }
)


def scenario_7b(rig: Rig) -> None:
    """The negative control only means something if the check can fail. Feed it an event that is in
    fact compatible and require that the check reports failures."""
    print("-- 7b: the negative control fails on a compatible event")
    global failures
    saved, failures = failures, []
    try:
        sink = io_redirect()
        rejected_by_both(rig, "compatible event posing as incompatible", "history_turn_committed", VALID_TURN)
        recorded = list(failures)
    finally:
        sink()
        failures = saved
    check(len(recorded) >= 2, f"the check reported {len(recorded)} failures for an event both implementations accept")


def io_redirect():
    """Silence the inner check's own output; returns a function that restores it."""
    original = sys.stdout
    sys.stdout = open(os.devnull, "w")

    def restore() -> None:
        sys.stdout.close()
        sys.stdout = original

    return restore


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bin", default="./zig-out/bin/fx")
    parser.add_argument("--session-tool", required=True)
    parser.add_argument("--turn-tool", required=True)
    parser.add_argument("--only", help="comma-separated scenario numbers")
    args = parser.parse_args()
    only = set(args.only.split(",")) if args.only else {"1", "2", "3", "5", "6", "7", "7b"}
    with tempfile.TemporaryDirectory() as tmp:
        rig = Rig(Path(args.bin).resolve(), Path(args.session_tool).resolve(), Path(args.turn_tool).resolve(), Path(tmp))
        for key, fn in (("1", scenario_1), ("2", scenario_2), ("3", scenario_3_and_4), ("5", scenario_5), ("6", scenario_6), ("7", scenario_7), ("7b", scenario_7b)):
            if key in only:
                fn(rig)
    if failures:
        print(f"\n{len(failures)} check(s) FAILED:")
        for message in failures:
            print(f"  - {message}")
        return 1
    print("\nsession interoperability: all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
