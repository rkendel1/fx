#!/usr/bin/env python3
"""Report Zig container-level declarations that nothing references.

Read-only. A top-level `fn` or `const` (pub or not) is dead when its name occurs exactly once as an identifier
token across every tracked `.zig` file under src/, tests/ and benchmarks/ plus build.zig, so the only occurrence
is the definition itself. Tokens inside string literals count too, so a name spelled out whole in an `@field` or
`@hasDecl` string is not reported.

Limits. This is a name-based token count, not a semantic reachability proof:

* It can flag a declaration that is still used. Zig can reach a declaration without spelling its name: a name
  assembled at comptime (`"fetch" ++ "Model"`) for `@field`/`@hasDecl`, iteration over `@typeInfo(T).@"struct".decls`
  (a public-surface audit, a comptime registry), or a lookup by a name supplied from outside the scanned files
  (JS/N-API glue, scripts, build options). A hit is a candidate. Delete it only after the build, every build
  surface (`-Dwasm-surface`, `-Dnapi-surface`, benchmarks) and the test suite pass without it.
* It misses most dead code: any declaration whose name is shared with another identifier anywhere stays alive.
* It does not see unused `export fn` declarations, struct members, or whole files (a file is only as dead as its
  importers).

A clean result therefore says only that no declaration is referenced by its definition alone. It does not prove
that anything else is safe to delete.

Usage (from the repository root):

    python3 docs/rebuild/tools/zig_dead_code.py          # list dead declarations
    python3 docs/rebuild/tools/zig_dead_code.py --check  # exit 1 if any exist

Used by check_retirement.py for the `zig-dead-code` retired entry.
"""

from __future__ import annotations

import argparse
import collections
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SCAN_DIRS = ("src", "tests", "benchmarks")
# Names std or the compiler look up implicitly; a declaration with one of these is never dead by token count.
IMPLICIT = {"main", "format", "jsonStringify", "jsonParse", "jsonParseFromValue", "panic", "std_options"}
TOKEN = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
DECL = re.compile(r"^(?:pub )?(?:inline )?(?:fn|const) ([A-Za-z_][A-Za-z0-9_]*)\b", re.M)


def zig_files(root: Path) -> list[Path]:
    out = []
    for d in SCAN_DIRS:
        out += [p for p in (root / d).rglob("*.zig") if "node_modules" not in p.parts]
    return sorted(out)


def find_dead(root: Path = ROOT) -> list[tuple[str, int, str]]:
    files = zig_files(root)
    texts = {p: p.read_text(errors="ignore") for p in files}
    counts: collections.Counter[str] = collections.Counter()
    for text in list(texts.values()) + [(root / "build.zig").read_text()]:
        counts.update(TOKEN.findall(text))
    dead = []
    for path, text in texts.items():
        for m in DECL.finditer(text):
            name = m.group(1)
            if counts[name] == 1 and name not in IMPLICIT:
                dead.append((str(path.relative_to(root)), text.count("\n", 0, m.start()) + 1, name))
    return dead


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="exit 1 when any dead declaration exists")
    args = ap.parse_args()
    dead = find_dead()
    for path, line, name in dead:
        print(f"{path}:{line}: {name} is declared but never referenced")
    print(f"zig dead declarations: {len(dead)}", file=sys.stderr)
    return 1 if args.check and dead else 0


if __name__ == "__main__":
    sys.exit(main())
