"""Cross-implementation check of the durable session store: the real Zig `fx` binary and the Rust
`chip-session` crate take turns on the same session directory.

  1. Zig creates a session (one turn).
  2. Rust appends an event with the Zig commit protocol.
  3. Zig resumes the session and runs another turn (it must accept the Rust-written event).
  4. Rust reads the result and checks the log is intact and contiguous, and that both writers' events are present.
  5. Rust creates a session of its own; Zig resumes it and runs a turn; Rust reads that too.

    python3 docs/rebuild/tools/verify_rust_session_resume.py --session-tool PATH [--bin ./zig-out/bin/fx]

PATH is the `session_tool` example built from rkendel1/chip-rs
(`cargo build -p chip-session --example session_tool`). Exit status is non-zero on any failure.
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

STARTED = {
    "id": "",
    "created_at_ms": 1,
    "origin_workspace_root": "",
    "workspace_root": "",
    "conversation_language": "und-Latn",
    "preferences": {"model": "zai/glm-5.2", "effort": "auto", "fast_mode": False},
}


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def zig_ask(binary: Path, home: Path, workspace: Path, prompt: str, resume: str | None) -> dict:
    port = free_port()
    with tempfile.TemporaryDirectory() as tmp:
        script, log = Path(tmp, "s.json"), Path(tmp, "l.jsonl")
        script.write_text(json.dumps([{"sse": text_stream(f"answer to {prompt}")}]))
        gateway = subprocess.Popen(
            [sys.executable, str(Path(__file__).parent / "scripted_gateway.py"), str(port), str(log), str(script)]
        )
        try:
            time.sleep(0.4)
            env = {
                **os.environ,
                "HOME": str(home),
                "AI_GATEWAY_API_KEY": "placeholder",
                "FX_GATEWAY_BASE_URL": f"http://127.0.0.1:{port}",
                "FX_GATEWAY_CHAT_URL": f"http://127.0.0.1:{port}/v3/ai/language-model",
            }
            args = [str(binary), "ask", "--json", "--yolo"] + (["--resume-id", resume] if resume else []) + ["--", prompt]
            done = subprocess.run(args, cwd=workspace, env=env, capture_output=True, text=True, timeout=120)
        finally:
            gateway.kill()
            gateway.wait()
    if done.returncode != 0:
        raise SystemExit(f"FAIL zig ask ({prompt!r}, resume={resume}) exit {done.returncode}: {done.stderr[-500:]}")
    return json.loads(done.stdout.strip().splitlines()[-1])


def tool(session_tool: Path, *args: str, stdin: str | None = None) -> dict:
    done = subprocess.run([str(session_tool), *args], input=stdin, capture_output=True, text=True, timeout=60)
    if done.returncode != 0:
        raise SystemExit(f"FAIL session_tool {args[0]}: {done.stderr.strip()}")
    return json.loads(done.stdout)


def check(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(f"FAIL {message}")
    print(f"ok   {message}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bin", default="./zig-out/bin/fx")
    parser.add_argument("--session-tool", required=True)
    args = parser.parse_args()
    binary, session_tool = Path(args.bin).resolve(), Path(args.session_tool).resolve()
    with tempfile.TemporaryDirectory() as tmp:
        home, workspace = Path(tmp, "home"), Path(tmp, "ws")
        home.mkdir()
        workspace.mkdir()
        sessions = home / ".fx" / "sessions"

        # Zig creates; Rust appends; Zig resumes; Rust reads.
        first = zig_ask(binary, home, workspace, "first", None)
        sid = first["session_id"]
        before = tool(session_tool, "read", str(sessions / sid))
        appended = tool(session_tool, "append", str(sessions / sid), "high")
        check(appended["through_seq"] == before["through_seq"] + 1, "Rust appended one event to a Zig-written session")
        second = zig_ask(binary, home, workspace, "second", sid)
        check(second["exit_code"] == 0 and second["session_id"] == sid, "Zig resumed the session after Rust's append")
        after = tool(session_tool, "read", str(sessions / sid))
        check(after["uncommitted_tail_bytes"] == 0, "the log has no uncommitted tail")
        seqs = [int(item.split(":")[0]) for item in after["frames"]]
        check(seqs == list(range(1, len(seqs) + 1)), f"sequence numbers are contiguous across both writers (1..{len(seqs)})")
        kinds = [item.split(":")[1] for item in after["frames"]]
        check("PreferencesChanged" in kinds, "Rust's event is in the log Zig continued")
        check(kinds.count("HistoryTurnCommitted") == 2, "Zig committed its second turn after Rust's event")

        # Rust creates; Zig resumes; Rust reads.
        rust_id = "rust-created-session"
        payload = dict(STARTED, id=rust_id, origin_workspace_root=str(workspace), workspace_root=str(workspace))
        created = tool(session_tool, "create", str(sessions), rust_id, stdin=json.dumps(payload, separators=(",", ":")))
        check(created["through_seq"] == 1, "Rust created a session")
        resumed = zig_ask(binary, home, workspace, "hello", rust_id)
        check(resumed["exit_code"] == 0 and resumed["session_id"] == rust_id, "Zig resumed a Rust-created session")
        final = tool(session_tool, "read", str(sessions / rust_id))
        check(final["uncommitted_tail_bytes"] == 0 and "HistoryTurnCommitted" in "".join(final["frames"]), "Rust reads the turn Zig wrote")
    print("session compatibility: all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
