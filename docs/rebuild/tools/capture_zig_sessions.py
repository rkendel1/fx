"""Records real session directories written by the Zig `fx` binary.

Parity tooling only. Each scenario runs `./zig-out/bin/fx ask --json --yolo` against
`scripted_gateway.py` in a throwaway HOME, then copies the durable files of the session
(the ones the format defines; not locks, indexes or caches) into OUT/<scenario>/. The Rust
session store's tests read these as the compatibility oracle.

    python3 docs/rebuild/tools/capture_zig_sessions.py --out PATH [--bin ./zig-out/bin/fx]

The binary must be a fresh build of this checkout.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from scripted_gateway import text_stream, tool_stream  # noqa: E402

DURABLE = ("session.json", "events.jsonl", "authority.json", "checkpoint.json", "display.json", "usage-v2.json")

SCENARIOS = {
    "single_text": {
        "turns": [("list the files", [{"sse": text_stream("hello from fake")}])],
    },
    "tool_round_trip": {
        "turns": [
            (
                "list the files",
                [{"sse": tool_stream("call_1", "list_files", '{"path":"."}')}, {"sse": text_stream("done after the tool")}],
            )
        ],
    },
    "resumed_two_turns": {
        "turns": [
            ("first question", [{"sse": text_stream("first answer")}]),
            ("second question", [{"sse": text_stream("second answer")}]),
        ],
    },
}


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def run_turn(binary: Path, home: Path, workspace: Path, prompt: str, script: list, resume: str | None) -> dict:
    port = free_port()
    with tempfile.TemporaryDirectory() as tmp:
        script_path, log_path = Path(tmp, "script.json"), Path(tmp, "log.jsonl")
        script_path.write_text(json.dumps(script))
        gateway = subprocess.Popen(
            [sys.executable, str(Path(__file__).parent / "scripted_gateway.py"), str(port), str(log_path), str(script_path)]
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
            args = [str(binary), "ask", "--json", "--yolo"]
            if resume:
                args += ["--resume-id", resume]
            args += ["--", prompt]
            done = subprocess.run(args, cwd=workspace, env=env, capture_output=True, text=True, timeout=120)
        finally:
            gateway.kill()
            gateway.wait()
    if done.returncode != 0:
        raise SystemExit(f"fx ask failed ({done.returncode}): {done.stderr[-400:]}")
    return json.loads(done.stdout.strip().splitlines()[-1])


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bin", default="./zig-out/bin/fx")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    binary = Path(args.bin).resolve()
    out = Path(args.out)
    version = subprocess.run([str(binary), "--version"], capture_output=True, text=True).stdout.strip()
    for name, scenario in SCENARIOS.items():
        with tempfile.TemporaryDirectory() as tmp:
            home, workspace = Path(tmp, "home"), Path(tmp, "ws")
            home.mkdir()
            workspace.mkdir()
            (workspace / "note.txt").write_text("hello\n")
            session_id = None
            for prompt, script in scenario["turns"]:
                result = run_turn(binary, home, workspace, prompt, script, session_id)
                session_id = result["session_id"]
            source = home / ".fx" / "sessions" / session_id
            target = out / name
            if target.exists():
                shutil.rmtree(target)
            target.mkdir(parents=True)
            copied = []
            for leaf in DURABLE:
                if (source / leaf).exists():
                    shutil.copy2(source / leaf, target / leaf)
                    copied.append(leaf)
            for mark in source.glob("commit.*.json"):
                shutil.copy2(mark, target / mark.name)
                copied.append(mark.name)
            (target / "PROVENANCE.json").write_text(
                json.dumps({"scenario": name, "binary": version, "session_id": session_id, "files": sorted(copied)}, indent=2) + "\n"
            )
            print(f"{name}: {session_id} {sorted(copied)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
