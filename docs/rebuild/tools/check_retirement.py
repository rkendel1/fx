#!/usr/bin/env python3
"""Machine-checks the R6 retirement gates (docs/rebuild/retirement.json).

FX side (always): no Rust crate here depends on Chip crates; only fx-core defines the executor;
no HTTP client crate is reachable from the executor crates; blocked entries name blockers; the
Chip runtime sources and tests exist.
Chip side (with --chip-rs PATH): no duplicate FX crate; the legacy HTTP consumer ratchet file
matches the real consumers. Exit status is non-zero on any violation.
"""
import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
HTTP_CLIENTS = {"reqwest", "hyper", "ureq", "isahc", "surf", "attohttpc"}


def crate_deps(manifest: Path) -> set[str]:
    deps, active = set(), False
    for line in manifest.read_text().splitlines():
        line = line.strip()
        if line.startswith("["):
            active = "dependencies" in line
        elif active and "=" in line:
            deps.add(line.split("=", 1)[0].strip())
    return deps


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--chip-rs", type=Path)
    args = ap.parse_args()
    cfg = json.loads((ROOT / "docs/rebuild/retirement.json").read_text())
    errors: list[str] = []

    for entry in cfg["blocked"]:
        if not entry.get("blockers"):
            errors.append(f"blocked entry {entry['id']} names no blockers")

    forbidden = set(cfg["fx_must_not_depend_on"])
    manifests = [p for p in (ROOT / "rust").glob("*/Cargo.toml")]
    for m in manifests:
        deps = crate_deps(m)
        bad = deps & forbidden
        if bad:
            errors.append(f"{m.relative_to(ROOT)} depends on Chip crates: {sorted(bad)}")
        name = m.parent.name
        if name in ("fx-core", "fx-single-attempt", "fx-wasm-abi", "fx-host"):
            http = deps & HTTP_CLIENTS
            if http:
                errors.append(f"{name} has an HTTP client dependency: {sorted(http)}")

    zig = cfg.get("zig_free_rust")
    if zig:
        for m in manifests + list((ROOT / "rust").glob("*/build.rs")):
            if re.search(zig["forbidden_in_manifests"], m.read_text(), re.IGNORECASE):
                errors.append(f"{m.relative_to(ROOT)} mentions Zig; Rust must not build or load Zig outputs")
        for rs in (ROOT / "rust").rglob("*.rs"):
            if "target" in rs.parts:
                continue
            text = rs.read_text(errors="ignore")
            for word in zig["forbidden_in_sources"]:
                if word in text:
                    errors.append(f"{rs.relative_to(ROOT)} references {word!r}; Rust must not depend on Zig outputs")

    parity = cfg.get("agent_parity")
    if parity:
        done = __import__("subprocess").run([sys.executable, "-I", str(ROOT / parity["runner"]), "check", "--results", str(ROOT / parity["results"])],
                                           capture_output=True, text=True)
        if done.returncode != 0:
            errors.append("agent-parity: " + (done.stderr.strip() or done.stdout.strip()).replace("\n", "; "))
        else:
            ready = json.loads((ROOT / parity["results"]).read_text())["gate"]["retirement_ready"]
            still_blocked = any(b["id"] == "zig-agent-loop" for b in cfg["blocked"])
            if not ready and not still_blocked:
                errors.append("zig-agent-loop left `blocked` but agent-parity.json says retirement_ready is false")
            print(f"agent-parity: stored result valid; retirement_ready={ready}")

    executors = [m.parent.name for m in manifests
                 if re.search(r"pub fn execute\b", "".join(p.read_text() for p in (m.parent / "src").rglob("*.rs")))]
    if executors != [cfg["single_executor"]["crate"].split("/")[1]]:
        errors.append(f"expected one executor crate, found {executors}")

    for needed in ["host/node/src/chip.js", "host/node/test-chip/chip.test.mjs", "host/node/test-chip/parity.test.mjs",
                   "host/node/examples/agent-mock.mjs", "docs/rebuild/CHIP_FX_RUNTIME.md", "docs/rebuild/evidence/zig-oracle.json"]:
        if not (ROOT / needed).exists():
            errors.append(f"missing {needed}")

    if args.chip_rs:
        crates = {p.parent.name for p in (args.chip_rs / "crates").glob("*/Cargo.toml")}
        for dup in ("fx-core", "fx-provider-http", "fx-single-attempt"):
            if dup in crates:
                errors.append(f"chip-rs still has a duplicate FX crate: {dup}")
        ratchet = args.chip_rs / "docs/product/legacy-http-consumers.txt"
        if not ratchet.exists():
            errors.append("chip-rs is missing legacy-http-consumers.txt")
        else:
            listed = [l for l in ratchet.read_text().splitlines() if l.strip() and not l.startswith("#")]
            print(f"chip-legacy-http consumers still listed: {len(listed)} (blocked: see retirement.json)")

    for e in errors:
        print(f"FAIL: {e}", file=sys.stderr)
    if not errors:
        print("retirement gates: all machine-checkable gates hold")
        print("blocked (explicit blockers recorded): " + ", ".join(b["id"] for b in cfg["blocked"]))
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
