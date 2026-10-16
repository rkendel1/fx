"""Records what the real Zig `fx` binary does in scripted scenarios.

Planning and parity tooling only. For each scenario it starts `scripted_gateway.py`, runs
`./zig-out/bin/fx ask --json` against it in a throwaway HOME and workspace, and records the
observable behavior: the JSON the binary printed, its exit code, how many inference requests
it made, and what each later request carried back. The result is
`docs/rebuild/evidence/zig-oracle.json`. The Rust parity tests compare Chip's behavior with
that file, so they run without the Zig binary; regenerate it with this script when the binary
changes.

    python3 docs/rebuild/tools/capture_zig_oracle.py [--bin ./zig-out/bin/fx] [--out PATH]

The binary must be a fresh build of this checkout (AGENTS.md: never the installed one).
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
from scripted_gateway import text_stream, tool_stream  # noqa: E402

TOOL_CALL = tool_stream("call_1", "list_files", '{"path":"."}')

SCENARIOS = {
    "single_text": {
        "about": "One text answer: a single inference, a completed turn.",
        "script": [{"sse": text_stream("hello from fake")}],
    },
    "tool_round_trip": {
        "about": "A tool call, its result fed back, then a text answer: two inferences, one tool run.",
        "script": [{"sse": TOOL_CALL}, {"sse": text_stream("done after the tool")}],
    },
    "unknown_tool": {
        "about": "A call to a tool that does not exist: the oracle reports it to the model and continues.",
        "script": [
            {"sse": tool_stream("call_1", "no_such_tool", "{}")},
            {"sse": text_stream("recovered after the unsupported tool")},
        ],
    },
    "malformed_tool_arguments": {
        "about": "A tool call whose arguments are not JSON: reported to the model, no tool runs.",
        "script": [
            {"sse": tool_stream("call_1", "list_files", "{not json")},
            {"sse": text_stream("recovered after malformed arguments")},
        ],
    },
    "http_429_then_success": {
        "about": "A rate limit, then success. The oracle repeats the request after an HTTP error whose delivery is ambiguous.",
        "script": [
            {"status": 429, "headers": {"retry-after": "1"}},
            {"sse": text_stream("hello after the rate limit")},
        ],
    },
    "http_500_then_success": {
        "about": "A server error, then success.",
        "script": [{"status": 500}, {"sse": text_stream("hello after the server error")}],
    },
    "http_400": {
        "about": "A client error: not retried, the turn fails.",
        "script": [{"status": 400, "body": json.dumps({"error": {"message": "bad request"}})}],
    },
    "cut_stream_then_success": {
        "about": "A stream cut off before its finish, then success.",
        "script": [
            {"sse": [{"type": "stream-start", "warnings": []}, {"type": "text-start", "id": "a"}, {"type": "text-delta", "id": "a", "delta": "partial "}], "truncate": True},
            {"sse": text_stream("hello after the cut stream")},
        ],
    },
    "step_limit": {
        "about": "Tool calls forever with a step limit of 2: the turn ends at the limit.",
        "script": [{"sse": tool_stream(f"call_{i}", "list_files", '{"path":"."}')} for i in range(1, 6)],
        "env": {"FX_MAX_AGENT_STEPS": "2"},
    },
}


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def summarize_request(body: object) -> dict:
    """Content-free facts about one inference request."""
    if not isinstance(body, dict):
        return {"kind": "not_json"}
    prompt = body.get("prompt", [])
    roles = [message.get("role") for message in prompt if isinstance(message, dict)]
    tool_results = []
    for message in prompt:
        if isinstance(message, dict) and message.get("role") == "tool":
            for part in message.get("content", []):
                if isinstance(part, dict) and part.get("type") == "tool-result":
                    tool_results.append(
                        {
                            "tool": part.get("toolName"),
                            "output": json.dumps(part.get("output"))[:240],
                        }
                    )
    return {
        "roles": roles,
        "tool_definitions": len(body.get("tools") or []),
        "tool_results_in_prompt": tool_results,
    }


def run(binary: Path, name: str, scenario: dict) -> dict:
    port = free_port()
    with tempfile.TemporaryDirectory() as tmp:
        home, workspace = Path(tmp, "home"), Path(tmp, "ws")
        home.mkdir()
        workspace.mkdir()
        (workspace / "note.txt").write_text("hello\n")
        script_path, log_path = Path(tmp, "script.json"), Path(tmp, "log.jsonl")
        script_path.write_text(json.dumps(scenario["script"]))
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
                **scenario.get("env", {}),
            }
            started = time.monotonic()
            done = subprocess.run(
                [str(binary), "ask", "--json", "--yolo", "--no-save", "list the files"],
                cwd=workspace,
                env=env,
                capture_output=True,
                text=True,
                timeout=120,
            )
            elapsed = time.monotonic() - started
        finally:
            gateway.kill()
            gateway.wait()
        posts = [
            json.loads(line)
            for line in log_path.read_text().splitlines()
            if json.loads(line)["method"] == "POST"
        ] if log_path.exists() else []
        try:
            output = json.loads(done.stdout.strip().splitlines()[-1])
        except (ValueError, IndexError):
            output = None
        return {
            "about": scenario["about"],
            "script_items": len(scenario["script"]),
            "exit_code": done.returncode,
            "inference_requests": len(posts),
            "requests": [summarize_request(post["body"]) for post in posts],
            "output": None if output is None else {
                "output": output.get("output"),
                "exit_code": output.get("exit_code"),
                "steps": output.get("steps"),
                "tool_calls": output.get("tool_calls"),
                "error": output.get("error"),
                "recovery": output.get("recovery"),
            },
            "seconds": round(elapsed, 1),
        }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bin", default="./zig-out/bin/fx")
    parser.add_argument("--out", default="docs/rebuild/evidence/zig-oracle.json")
    parser.add_argument("--only", help="comma-separated scenario names")
    args = parser.parse_args()
    binary = Path(args.bin).resolve()
    if not binary.exists():
        print(f"{binary} does not exist; build with zig build first", file=sys.stderr)
        return 2
    version = subprocess.run([str(binary), "--version"], capture_output=True, text=True).stdout.strip()
    names = args.only.split(",") if args.only else list(SCENARIOS)
    results = {name: run(binary, name, SCENARIOS[name]) for name in names}
    document = {"schema": 1, "binary": version, "scenarios": results}
    Path(args.out).write_text(json.dumps(document, indent=2) + "\n")
    for name, result in results.items():
        print(f"{name}: requests={result['inference_requests']} exit={result['exit_code']} {result['seconds']}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
