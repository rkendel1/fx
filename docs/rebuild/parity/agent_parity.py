#!/usr/bin/env python3
"""Agent-loop parity run: the same scripted scenarios through the Zig `fx ask` loop and Rust Chip.

    python3 docs/rebuild/parity/agent_parity.py run   --fx-bin ./zig-out/bin/fx --chip-bin PATH/chip \
        --turn-tool PATH/turn_tool --session-tool PATH/session_tool [--out docs/rebuild/evidence/agent-parity.json]
    python3 docs/rebuild/parity/agent_parity.py check [--results PATH]      # no binaries needed

`run` executes every scenario in `agent-loop.v1.json` against both implementations and writes a
machine-readable result: for each scenario the normalized observation of each side, the fields that
match, and every difference with its classification. `check` validates a stored result against the
corpus (same corpus hash, no unclassified or stale difference) and prints the retirement gate.

Compared are observable facts only. A difference is never accepted by the runner: it must be written
down in the corpus with a class and a reason, and a difference the corpus predicts but that did not
occur is an error too, so the corpus cannot drift into fiction.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
CORPUS = HERE / "agent-loop.v1.json"
DEFAULT_RESULTS = ROOT / "docs/rebuild/evidence/agent-parity.json"
sys.path.insert(0, str(ROOT / "docs/rebuild/tools"))
from scripted_gateway import text_stream, tool_stream  # noqa: E402

TOKEN = "fixture-token-7f3a"
ZIG_KIND = {"read_file": "read", "write_file": "write", "terminal": "shell"}
CHIP_KIND = {"project.read": "read", "project.write": "write"}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class Gateway:
    """One scripted loopback endpoint (Zig wire or OpenAI wire) and its request log."""

    def __init__(self, tmp: Path, flavor: str, script: list[dict]) -> None:
        self.port = free_port()
        self.log = tmp / f"{flavor}.log.jsonl"
        self.log.write_text("")
        script_file = tmp / f"{flavor}.script.json"
        script_file.write_text(json.dumps(script))
        program = ROOT / ("docs/rebuild/tools/scripted_gateway.py" if flavor == "zig" else "docs/rebuild/parity/openai_gateway.py")
        self.proc = subprocess.Popen([sys.executable, str(program), str(self.port), str(self.log), str(script_file)])
        for _ in range(50):
            try:
                socket.create_connection(("127.0.0.1", self.port), 0.1).close()
                break
            except OSError:
                time.sleep(0.1)

    def posts(self) -> list[dict]:
        rows = [json.loads(line) for line in self.log.read_text().splitlines() if line.strip()]
        return [r for r in rows if r["method"] == "POST"]

    def wait_for_post(self, seconds: float = 15) -> bool:
        end = time.time() + seconds
        while time.time() < end:
            if self.posts():
                return True
            time.sleep(0.05)
        return False

    def stop(self) -> None:
        self.proc.kill()
        self.proc.wait()


# ---- scripts: one abstract model, two wire formats -----------------------------------------------------------------


def zig_script(model: list[dict], marker: str) -> list[dict]:
    out: list[dict] = []
    for i, step in enumerate(model):
        cid = f"call_{i + 1}"
        if "say" in step:
            out.append({"sse": text_stream(step["say"])})
        elif "read" in step:
            out.append({"sse": tool_stream(cid, "read_file", json.dumps({"path": step["read"]}))})
        elif "unknown" in step:
            out.append({"sse": tool_stream(cid, step["unknown"], "{}")})
        elif "shell" in step:
            out.append({"sse": tool_stream(cid, "terminal", json.dumps({"command": step["shell"].format(marker=marker)}))})
        elif "write_outside" in step:
            out.append({"sse": tool_stream(cid, "write_file", json.dumps({"path": "../" + step["write_outside"], "content": "x"}))})
        elif "http" in step:
            item = {"status": step["http"]}
            if "retry_after" in step:
                item["headers"] = {"retry-after": str(step["retry_after"])}
            out.append(item)
        elif "cut" in step:
            out.append({"sse": [{"type": "stream-start", "warnings": []}, {"type": "text-start", "id": "a"}, {"type": "text-delta", "id": "a", "delta": step["cut"]}], "truncate": True})
        elif "hang" in step:
            out.append({"sse": [{"type": "stream-start", "warnings": []}, {"type": "text-start", "id": "a"}, {"type": "text-delta", "id": "a", "delta": step["hang"]}], "hang": True})
    return out


def chip_script(model: list[dict], marker: str, work: bool) -> list[dict]:
    out: list[dict] = []
    decision = lambda **kw: json.dumps(kw, separators=(",", ":"))  # noqa: E731
    for step in model:
        if "say" in step:
            out.append({"text": decision(decision="complete", summary=step["say"]) if work else step["say"]})
        elif "read" in step:
            out.append({"text": decision(decision="request_capability", capability="project.read", inputs={"path": step["read"]})})
        elif "unknown" in step:
            out.append({"text": decision(decision="request_capability", capability=step["unknown"], inputs={})})
        elif "shell" in step:
            out.append({"text": decision(decision="request_capability", capability="shell.run", inputs={"command": step["shell"].format(marker=marker)})})
        elif "write_outside" in step:
            out.append({"text": decision(decision="request_capability", capability="project.write", inputs={"path": "../" + step["write_outside"], "content": "x"})})
        elif "http" in step:
            item = {"status": step["http"]}
            if "retry_after" in step:
                item["headers"] = {"retry-after": str(step["retry_after"])}
            out.append(item)
        elif "cut" in step:
            out.append({"text": step["cut"], "truncate": True})
        elif "hang" in step:
            out.append({"text": step["hang"], "hang": True})
    return out


# ---- running one process ------------------------------------------------------------------------------------------------


def run_process(cmd: list[str], cwd: Path, env: dict, gateway: Gateway, sig: str | None, timeout: float = 60) -> tuple[int, str, str]:
    proc = subprocess.Popen(cmd, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if sig:
        gateway.wait_for_post()
        time.sleep(0.6)
        proc.send_signal(getattr(signal, sig))
    try:
        out, err = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        out, err = proc.communicate()
        return 124, out, err + "[timeout]"
    return proc.returncode, out, err


def setup(tmp: Path, fixture: dict, chip: bool) -> Path:
    ws = tmp / "ws"
    ws.mkdir()
    for name, text in fixture["files"].items():
        (ws / name).write_text(text)
    if chip:
        (ws / "Cargo.toml").write_text('[package]\nname = "p"\nversion = "0.1.0"\nedition = "2021"\n')
        (ws / "src").mkdir()
        (ws / "src/lib.rs").write_text("pub fn one() -> u8 { 1 }\n")
    return ws


def effects(tmp: Path) -> dict:
    return {"outside_write": (tmp / "outside.txt").exists(), "shell_marker": (tmp / "marker").exists()}


def coarse(terminal: str) -> str:
    return terminal if terminal in ("completed", "killed_by_signal") else "not_completed"


def followup_has_token(posts: list[dict]) -> bool:
    return any(TOKEN in json.dumps(p["body"]) for p in posts[1:])


def run_zig(sc: dict, fx: Path, fixture: dict) -> dict:
    with tempfile.TemporaryDirectory() as t:
        tmp = Path(t)
        (tmp / "home").mkdir()
        ws = setup(tmp, fixture, chip=False)
        gw = Gateway(tmp, "zig", zig_script(sc["model"], str(tmp / "marker")))
        try:
            env = {**os.environ, "HOME": str(tmp / "home"), "AI_GATEWAY_API_KEY": "placeholder",
                   "FX_GATEWAY_BASE_URL": f"http://127.0.0.1:{gw.port}",
                   "FX_GATEWAY_CHAT_URL": f"http://127.0.0.1:{gw.port}/v3/ai/language-model"}
            if "limit" in sc:
                env["FX_MAX_AGENT_STEPS"] = str(sc["limit"])
            rc, out, err = run_process([str(fx), "ask", "--json", "--no-save", sc["prompt"]], ws, env, gw, sc.get("signal"))
            posts = gw.posts()
        finally:
            gw.stop()
        try:
            doc = json.loads(out.strip().splitlines()[-1])
        except (ValueError, IndexError):
            doc = None
        if rc < 0:
            terminal = "killed_by_signal"
        elif doc and rc == 0 and not doc.get("error"):
            terminal = "completed"
        else:
            terminal = "failed"
        calls = (doc or {}).get("tool_calls") or []
        return {
            "terminal": coarse(terminal), "terminal_detail": terminal,
            "answer": (doc or {}).get("output") if terminal == "completed" else None,
            "inference_requests": len(posts),
            "tool_executions": sorted(ZIG_KIND.get(c["name"], c["name"]) for c in calls if c.get("status") == "success"),
            "followup_carries_tool_result": followup_has_token(posts),
            "side_effects": effects(tmp),
        }


def run_chip(sc: dict, chip: Path, fixture: dict) -> dict:
    steps = sc["model"]
    work = any(k in s for s in steps for k in ("read", "unknown", "shell", "write_outside"))
    with tempfile.TemporaryDirectory() as t:
        tmp = Path(t)
        ws = setup(tmp, fixture, chip=True)
        gw = Gateway(tmp, "chip", chip_script(steps, str(tmp / "marker"), work))
        try:
            env = {**os.environ, "CHIP_PROVIDER": "openai-compatible", "CHIP_MODEL": "parity-model",
                   "CHIP_ENDPOINT": f"http://127.0.0.1:{gw.port}/v1/chat/completions"}
            for k in ("CHIP_EXECUTOR", "CHIP_ENABLE_THINKING", "CHIP_API_KEY"):
                env.pop(k, None)
            if work:
                kind = "change" if any("write_outside" in s for s in steps) else "inspect"
                cmd = [str(chip), "work", "--kind", kind, "--json", sc["prompt"]]
                if "limit" in sc:
                    cmd += ["--max-turns", str(sc["limit"])]
            else:
                cmd = [str(chip), sc["prompt"]]
            rc, out, err = run_process(cmd, ws, env, gw, sc.get("signal"))
            posts = gw.posts()
        finally:
            gw.stop()
        if rc < 0:
            return {"terminal": "killed_by_signal", "terminal_detail": "killed_by_signal", "answer": None,
                    "inference_requests": len(posts), "tool_executions": [], "followup_carries_tool_result": followup_has_token(posts),
                    "side_effects": effects(tmp)}
        if work:
            try:
                doc = json.loads(out)
            except ValueError:
                doc = {}
            state = doc.get("terminal_state", "failed")
            execs = []
            for cap, n in (doc.get("executions_by_capability") or {}).items():
                execs += [CHIP_KIND.get(cap, cap)] * n
            return {"terminal": coarse(state), "terminal_detail": state, "answer": doc.get("answer") if state == "completed" else None,
                    "inference_requests": len(posts), "tool_executions": sorted(execs),
                    "followup_carries_tool_result": followup_has_token(posts), "side_effects": effects(tmp)}
        done = "Turn completed" in out
        answer = out.split("Turn completed\n", 1)[1].rstrip("\n") if done else None
        return {"terminal": "completed" if done else "not_completed", "terminal_detail": "completed" if done else f"exit {rc}",
                "answer": answer, "inference_requests": len(posts), "tool_executions": [],
                "followup_carries_tool_result": followup_has_token(posts), "side_effects": effects(tmp)}


# ---- recovery and persistence --------------------------------------------------------------------------------------


STARTED = {"id": "parity-1", "created_at_ms": 1, "origin_workspace_root": "", "workspace_root": "",
           "conversation_language": "und-Latn", "preferences": {"model": "zai/glm-5.2", "effort": "auto", "fast_mode": False}}


def zig_env(tmp: Path, gw: Gateway) -> dict:
    return {**os.environ, "HOME": str(tmp / "home"), "AI_GATEWAY_API_KEY": "placeholder",
            "FX_GATEWAY_BASE_URL": f"http://127.0.0.1:{gw.port}",
            "FX_GATEWAY_CHAT_URL": f"http://127.0.0.1:{gw.port}/v3/ai/language-model"}


def recovery(fx: Path, turn_tool: Path, session_tool: Path, fixture: dict) -> tuple[dict, dict]:
    with tempfile.TemporaryDirectory() as t:
        tmp = Path(t)
        (tmp / "home").mkdir()
        ws = setup(tmp, fixture, chip=False)
        partial = [{"type": "stream-start", "warnings": []}, {"type": "text-start", "id": "a"}, {"type": "text-delta", "id": "a", "delta": "partial answer "}]
        gw = Gateway(tmp, "zig", [{"sse": partial, "hang": True}])
        try:
            rc1, out1, _ = run_process([str(fx), "ask", "--json", "say hello"], ws, zig_env(tmp, gw), gw, "SIGKILL")
        finally:
            gw.stop()
        (tmp / "second").mkdir()
        gw2 = Gateway(tmp / "second", "zig", [{"sse": text_stream("recovered answer")}])
        try:
            rc2, out2, _ = run_process([str(fx), "ask", "--json", "--resume", "last", "--continue-recovery"], ws, zig_env(tmp, gw2), gw2, None)
            requests2 = len(gw2.posts())
        finally:
            gw2.stop()
        try:
            doc2 = json.loads(out2.strip().splitlines()[-1])
        except (ValueError, IndexError):
            doc2 = {}
        zig = {"first_run_claimed_complete": bool(out1.strip()), "completed_after_restart": rc2 == 0 and bool(doc2.get("output")),
               "interrupted_turn_not_claimed_complete": not out1.strip(),
               "resumes_the_interrupted_model_response": rc2 == 0 and (doc2.get("recovery") or {}).get("state") == "recovered",
               "inference_requests_on_restart": requests2, "side_effects_replayed_on_rerun": None}
    with tempfile.TemporaryDirectory() as t:
        root = Path(t)
        sessions = root / "sessions"
        sessions.mkdir()
        subprocess.run([str(session_tool), "create", str(sessions), "parity-1"], input=json.dumps(STARTED), text=True, capture_output=True, check=True)
        replies = root / "replies.json"
        replies.write_text(json.dumps(['{"decision":"request_capability","capability":"compute.selftest"}', '{"decision":"complete","summary":"done"}']))
        sdir = str(sessions / "parity-1")
        crashed = subprocess.run([str(turn_tool), "run", sdir, str(replies), "run the self test"], env={**os.environ, "CHIP_SESSION_CRASH": "after_event_append"}, capture_output=True, text=True)
        history = json.loads(subprocess.run([str(turn_tool), "history", sdir], capture_output=True, text=True).stdout)
        again = subprocess.run([str(turn_tool), "run", sdir, str(replies), "run the self test"], capture_output=True, text=True)
        final = json.loads(subprocess.run([str(turn_tool), "history", sdir], capture_output=True, text=True).stdout)
        rust = {"first_run_claimed_complete": bool(crashed.stdout.strip()), "completed_after_restart": again.returncode == 0 and '"persistence":"committed"' in again.stdout,
                "interrupted_turn_not_claimed_complete": crashed.returncode != 0 and not crashed.stdout.strip() and history["turns"] == [],
                "resumes_the_interrupted_model_response": False,
                "inference_requests_on_restart": None,
                # By construction: the crash points are inside persistence, after the work ran; the rerun runs the work again.
                "side_effects_replayed_on_rerun": len(final["turns"]) == 1 and again.returncode == 0}
    return zig, rust


def persistence(fx: Path, turn_tool: Path, fixture: dict) -> tuple[dict, dict]:
    with tempfile.TemporaryDirectory() as t:
        tmp = Path(t)
        (tmp / "home/.fx").mkdir(parents=True)
        (tmp / "home/.fx/sessions").write_text("a file where the sessions directory should be")
        ws = setup(tmp, fixture, chip=False)
        gw = Gateway(tmp, "zig", [{"sse": text_stream("hello")}])
        try:
            rc, out, err = run_process([str(fx), "ask", "--json", "say hello"], ws, zig_env(tmp, gw), gw, None)
        finally:
            gw.stop()
        try:
            doc = json.loads(out.strip().splitlines()[-1])
        except (ValueError, IndexError):
            doc = {}
        zig = {"answers_without_saving": rc == 0 and bool(doc.get("output")), "no_claim_of_durable_session": not doc.get("session_id"),
               "failure_after_work_ran": None, "warned": "persistence unavailable" in err}
    with tempfile.TemporaryDirectory() as t:
        root = Path(t)
        (root / "parity-1").write_text("a file where the session directory should be")
        replies = root / "replies.json"
        replies.write_text(json.dumps(['{"decision":"complete","summary":"done"}']))
        done = subprocess.run([str(turn_tool), "run", str(root / "parity-1"), str(replies), "say hello"], capture_output=True, text=True)
        rust = {"answers_without_saving": bool(done.stdout.strip()), "no_claim_of_durable_session": '"persistence":"committed"' not in done.stdout,
                "failure_after_work_ran": None, "warned": bool(done.stderr.strip())}
    return zig, rust


# ---- comparing -------------------------------------------------------------------------------------------------------


def comparable(side: dict, field: str):
    if field == "terminal_not_completed":
        return side["terminal"] != "completed"
    return side.get(field)


def judge(sc: dict, zig: dict, rust: dict) -> dict:
    compare = list(sc["compare"])
    declared = sc.get("differences", {})
    fields = list(dict.fromkeys(compare + list(declared)))
    matched, differences, unclassified, stale = [], [], [], []
    for f in fields:
        z, r = comparable(zig, f), comparable(rust, f)
        if z == r:
            (stale if f in declared else matched).append(f)
            continue
        entry = {"field": f, "zig": z, "rust": r}
        if f in declared:
            entry |= {"class": declared[f]["class"], "why": declared[f]["why"]}
            differences.append(entry)
        else:
            unclassified.append(entry)
    status = "unclassified_difference" if unclassified else "stale_declared_difference" if stale else "classified_differences" if differences else "match"
    return {"status": status, "matched": matched, "differences": differences, "unclassified": unclassified, "stale": stale}


def gate(corpus: dict, results: dict) -> dict:
    scen = results["scenarios"]
    unclassified = [s for s, r in sorted(scen.items()) if r["verdict"]["status"] in ("unclassified_difference", "stale_declared_difference") or r.get("error")]
    open_items = []
    for sid, r in sorted(scen.items()):
        for d in r["verdict"]["differences"]:
            if corpus["approvals"].get(f"{sid}.{d['field']}") != "approved":
                open_items.append({"scenario": sid, "field": d["field"], "class": d["class"]})
    blockers = [b["id"] for b in corpus["unsupported_behaviors"]]
    return {
        "run_is_valid": not unclassified,
        "invalid_scenarios": unclassified,
        "unapproved_differences": open_items,
        "unsupported_behaviors": blockers,
        "unsupported_by_category": {c: sorted(b["id"] for b in corpus["unsupported_behaviors"] if b["category"] == c) for c in sorted(corpus["categories"])},
        "retirement_ready": not unclassified and not open_items and not blockers,
    }


def cmd_run(args) -> int:
    corpus = json.loads(CORPUS.read_text())
    fx, chip = Path(args.fx_bin).resolve(), Path(args.chip_bin).resolve()
    turn_tool, session_tool = Path(args.turn_tool).resolve(), Path(args.session_tool).resolve()
    for p in (fx, chip, turn_tool, session_tool):
        if not p.exists():
            print(f"missing {p}", file=sys.stderr)
            return 2
    scen: dict = {}
    for sc in corpus["scenarios"]:
        try:
            if sc.get("driver") == "recovery":
                zig, rust = recovery(fx, turn_tool, session_tool, corpus["fixture"])
            elif sc.get("driver") == "persistence":
                zig, rust = persistence(fx, turn_tool, corpus["fixture"])
            else:
                zig, rust = run_zig(sc, fx, corpus["fixture"]), run_chip(sc, chip, corpus["fixture"])
            scen[sc["id"]] = {"requirement": sc["requirement"], "about": sc["about"], "zig": zig, "rust": rust, "verdict": judge(sc, zig, rust)}
        except Exception as error:  # a scenario that cannot run is a failure of the run, never a pass
            scen[sc["id"]] = {"requirement": sc["requirement"], "about": sc["about"], "error": repr(error),
                              "verdict": {"status": "unclassified_difference", "matched": [], "differences": [], "unclassified": [], "stale": []}}
    results = {
        "schema": 1, "corpus": corpus["version"], "corpus_sha256": sha256(CORPUS),
        "tools": {"zig_fx": subprocess.run([str(fx), "--version"], capture_output=True, text=True).stdout.strip(), "zig_fx_sha256": sha256(fx),
                  "chip": subprocess.run([str(chip), "--version"], capture_output=True, text=True).stdout.strip(), "chip_sha256": sha256(chip),
                  "chip_rs_ref": args.chip_rs_ref, "python": platform.python_version()},
        "scenarios": scen,
    }
    results["gate"] = gate(corpus, results)
    Path(args.out).write_text(json.dumps(results, indent=2, sort_keys=True) + "\n")
    print_summary(results)
    return 0 if results["gate"]["run_is_valid"] else 1


def print_summary(results: dict) -> None:
    for sid, r in results["scenarios"].items():
        v = r["verdict"]
        print(f"{sid:26} {v['status']:26} matched={len(v['matched'])} classified={len(v['differences'])}")
    # A run that is not valid must say WHY in its log: which fields differed and what each side did.
    for sid, r in results["scenarios"].items():
        v = r["verdict"]
        for entry in v.get("unclassified", []):
            print(f"UNCLASSIFIED {sid}.{entry['field']}: zig={entry['zig']!r} rust={entry['rust']!r}")
        for field in v.get("stale", []):
            print(f"STALE {sid}.{field}: declared as a difference but both sides agreed")
        if v["status"] == "unclassified_difference" and r.get("zig"):
            print(f"  {sid} zig : {json.dumps(r['zig'], sort_keys=True)}")
            print(f"  {sid} rust: {json.dumps(r['rust'], sort_keys=True)}")
        if r.get("error"):
            print(f"ERROR {sid}: {r['error']}")
    g = results["gate"]
    print(f"run valid: {g['run_is_valid']}; unapproved differences: {len(g['unapproved_differences'])}; "
          f"unsupported behaviors: {len(g['unsupported_behaviors'])}; retirement ready: {g['retirement_ready']}")


def cmd_check(args) -> int:
    corpus = json.loads(CORPUS.read_text())
    results = json.loads(Path(args.results).read_text())
    errors = []
    if results.get("corpus_sha256") != sha256(CORPUS):
        errors.append("results were produced from a different corpus; re-run the parity run")
    if set(results["scenarios"]) != {s["id"] for s in corpus["scenarios"]}:
        errors.append("results and corpus list different scenarios")
    by_id = {s["id"]: s for s in corpus["scenarios"]}
    for sid, r in results["scenarios"].items():
        if "error" in r or sid not in by_id:
            continue
        if judge(by_id[sid], r["zig"], r["rust"]) != r["verdict"]:
            errors.append(f"{sid}: the stored verdict does not follow from the stored observations")
    declared = {f"{sc['id']}.{f}" for sc in corpus["scenarios"] for f in sc.get("differences", {})}
    for key, value in corpus["approvals"].items():
        if key not in declared:
            errors.append(f"approval {key!r} names no declared difference")
        if value != "approved":
            errors.append(f"approval {key!r} must be exactly 'approved'")
    fresh = gate(corpus, results)
    if fresh != results.get("gate"):
        errors.append("the stored gate does not follow from the stored scenarios")
    if not fresh["run_is_valid"]:
        errors.append(f"invalid scenarios: {fresh['invalid_scenarios']}")
    for e in errors:
        print(f"FAIL: {e}", file=sys.stderr)
    print_summary(results)
    return 1 if errors else 0


def cmd_diff(args) -> int:
    a, b = (json.loads(Path(p).read_text()) for p in (args.a, args.b))
    same = a["corpus_sha256"] == b["corpus_sha256"] and a["scenarios"] == b["scenarios"] and a["gate"] == b["gate"]
    if not same:
        for sid in sorted(set(a["scenarios"]) | set(b["scenarios"])):
            if a["scenarios"].get(sid) != b["scenarios"].get(sid):
                print(f"DIFFERS: {sid}", file=sys.stderr)
    print("results agree" if same else "results differ")
    return 0 if same else 1


def main() -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    run = sub.add_parser("run")
    run.add_argument("--fx-bin", default=str(ROOT / "zig-out/bin/fx"))
    run.add_argument("--chip-bin", required=True)
    run.add_argument("--turn-tool", required=True)
    run.add_argument("--session-tool", required=True)
    run.add_argument("--chip-rs-ref", default="", help="the chip-rs commit the binaries were built from, recorded in the results")
    run.add_argument("--out", default=str(DEFAULT_RESULTS))
    diff = sub.add_parser("diff", help="fail unless two results agree on every scenario and the gate (binary hashes are ignored)")
    diff.add_argument("a")
    diff.add_argument("b")
    chk = sub.add_parser("check")
    chk.add_argument("--results", default=str(DEFAULT_RESULTS))
    args = ap.parse_args()
    if args.cmd == "diff":
        return cmd_diff(args)
    return cmd_run(args) if args.cmd == "run" else cmd_check(args)


if __name__ == "__main__":
    sys.exit(main())
