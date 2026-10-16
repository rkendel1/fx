#!/usr/bin/env python3
"""Reproduction for docs/rebuild/security/ZIG_EXTERNAL_WRITE.md: which file-mutating tools of the Zig
`fx ask` loop act on a path OUTSIDE the workspace in the default permission mode.

    python3 docs/rebuild/security/repro_external_mutation.py --fx-bin PATH   # use a FRESH build of this checkout

Everything happens under one throwaway directory: the workspace is `<tmp>/ws`, the "outside" area is
`<tmp>/outside`. No path outside the throwaway directory is touched. The model is a scripted loopback
endpoint (no credentials, no network). For each tool the script asks the model to mutate an outside path
and reports (a) whether the auto-mode permission reviewer was invoked (a POST that offers only the
`permission_decision` tool) and (b) whether the effect happened. The scripted endpoint never answers the
reviewer validly, so a reviewed action is denied; an action that never reaches the reviewer is exposed.
"""
import argparse
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from scripted_gateway import text_stream, tool_stream  # noqa: E402


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def probe(fx: Path, flags: list[str], tool: str, make_args, setup, effect) -> tuple[int, bool]:
    with tempfile.TemporaryDirectory() as t:
        tmp = Path(t)
        ws, outside, home = tmp / "ws", tmp / "outside", tmp / "home"
        for d in (ws, outside, home):
            d.mkdir()
        setup(outside)
        script = tmp / "script.json"
        log = tmp / "log.jsonl"
        script.write_text(json.dumps([{"sse": tool_stream("c1", tool, json.dumps(make_args(outside)))},
                                      {"sse": text_stream("ok")}, {"sse": text_stream("ok")}]))
        port = free_port()
        gw = subprocess.Popen([sys.executable, str(Path(__file__).resolve().parents[1] / "tools/scripted_gateway.py"), str(port), str(log), str(script)])
        try:
            time.sleep(0.5)
            env = {**os.environ, "HOME": str(home), "AI_GATEWAY_API_KEY": "placeholder",
                   "FX_GATEWAY_BASE_URL": f"http://127.0.0.1:{port}", "FX_GATEWAY_CHAT_URL": f"http://127.0.0.1:{port}/v3/ai/language-model"}
            subprocess.run([str(fx), "ask", "--json", "--no-save", *flags, "do it"], cwd=ws, env=env, capture_output=True, text=True, timeout=45)
        except subprocess.TimeoutExpired:
            pass
        finally:
            gw.kill()
            gw.wait()
        posts = [json.loads(line) for line in log.read_text().splitlines() if json.loads(line)["method"] == "POST"]
        reviewed = sum(1 for p in posts if [x.get("name") for x in (p["body"].get("tools") or [])] == ["permission_decision"])
        return reviewed, effect(outside)


CASES = [
    ("write_file: create a NEW file outside", "write_file", lambda o: {"path": str(o / "new.txt"), "content": "x"}, lambda o: (o / "victim.txt").write_text("precious\n"), lambda o: (o / "new.txt").exists()),
    ("write_file: create via ../ from the workspace", "write_file", lambda o: {"path": "../outside/up.txt", "content": "x"}, lambda o: None, lambda o: (o / "up.txt").exists()),
    ("write_file: OVERWRITE an existing file", "write_file", lambda o: {"path": str(o / "victim.txt"), "content": "OVERWRITTEN"}, lambda o: (o / "victim.txt").write_text("precious\n"), lambda o: (o / "victim.txt").read_text().startswith("OVERWRITTEN")),
    ("edit_file: edit an existing file", "edit_file", lambda o: {"path": str(o / "victim.txt"), "old_string": "precious", "new_string": "edited"}, lambda o: (o / "victim.txt").write_text("precious\n"), lambda o: "edited" in (o / "victim.txt").read_text()),
    ("delete_file", "delete_file", lambda o: {"path": str(o / "victim.txt")}, lambda o: (o / "victim.txt").write_text("precious\n"), lambda o: not (o / "victim.txt").exists()),
    ("create_folder", "create_folder", lambda o: {"path": str(o / "newdir")}, lambda o: None, lambda o: (o / "newdir").is_dir()),
    ("copy_file (to outside)", "copy_file", lambda o: {"source": str(o / "victim.txt"), "destination": str(o / "copy.txt")}, lambda o: (o / "victim.txt").write_text("precious\n"), lambda o: (o / "copy.txt").exists()),
    ("rename_file", "rename_file", lambda o: {"old_path": str(o / "victim.txt"), "new_path": str(o / "renamed.txt")}, lambda o: (o / "victim.txt").write_text("precious\n"), lambda o: (o / "renamed.txt").exists()),
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fx-bin", required=True)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    fx = Path(args.fx_bin).resolve()
    version = subprocess.run([str(fx), "--version"], capture_output=True, text=True).stdout.strip()
    rows = []
    for name, tool, make, setup, effect in CASES:
        reviewed, happened = probe(fx, [], tool, make, setup, effect)
        rows.append({"case": name, "reviewer_invoked": reviewed, "effect_happened": happened})
    if args.json:
        print(json.dumps({"binary": version, "mode": "default (no flags)", "rows": rows}, indent=2))
    else:
        print(f"fx {version}, default permission mode, scripted model that never answers the reviewer validly")
        for r in rows:
            exposed = r["effect_happened"] and not r["reviewer_invoked"]
            print(f"  {r['case']:48} reviewer_invoked={r['reviewer_invoked']} effect_happened={r['effect_happened']}{'   <-- EXPOSED' if exposed else ''}")
    return 1 if any(r["effect_happened"] and not r["reviewer_invoked"] for r in rows) else 0


if __name__ == "__main__":
    sys.exit(main())
