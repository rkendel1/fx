"""Generate the FX rebuild inventories from the tracked tree.

Planning tooling only. It reads `git ls-files`, extracts every declaration with
a line-oriented scanner, and classifies each path with the ordered prefix rules
in `docs/rebuild/inventory/ownership_rules.tsv`. Nothing in the product build,
tests, or CI imports this script.

Usage (from the repository root):

    python3 docs/rebuild/tools/generate_inventory.py          # regenerate
    python3 docs/rebuild/tools/generate_inventory.py --check  # fail if stale or unclassified

Outputs, all under `docs/rebuild/inventory/`:

    files.tsv     every tracked file: kind, lines, declaration and test counts, rule
    symbols.tsv   every production declaration (functions, types, exports)
    summary.md    totals per rule, owner, and disposition

Caller evidence is lexical: the number of other tracked source files whose
identifier tokens include the symbol name. References only count within
one language family (Zig, or JavaScript/TypeScript/HTML). Names defined in six
or more files (`init`, `deinit`, `format`, ...) or referenced from more than
40 files are marked `ambiguous` instead of counted, because a token match then
says nothing about which definition is called.
"""

from __future__ import annotations

import argparse
import collections
import dataclasses
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[3]
OUT = ROOT / "docs" / "rebuild" / "inventory"
RULES = OUT / "ownership_rules.tsv"
OVERRIDES = OUT / "symbol_overrides.tsv"
LEDGER = ROOT / "docs" / "rebuild" / "CAPABILITIES.md"
SELF_PREFIX = "docs/rebuild/"

ZIG_FN = re.compile(
    r"^(?P<indent>\s*)(?P<vis>pub\s+)?(?P<mods>(?:export\s+|extern\s+(?:\"\w+\"\s+)?|inline\s+|noinline\s+)*)fn\s+(?P<name>@?\"?[A-Za-z_][\w]*\"?)\s*\("
)
ZIG_TYPE = re.compile(
    r"^(?P<indent>\s*)(?P<vis>pub\s+)?const\s+(?P<name>[A-Za-z_]\w*)\s*(?::\s*type\s*)?=\s*(?:extern\s+|packed\s+)?(?P<kind>struct|enum|union|opaque|error)\b"
)
ZIG_GENERIC = re.compile(
    r"^(?P<indent>\s*)(?P<vis>pub\s+)?fn\s+(?P<name>[A-Za-z_]\w*)\s*\([^)]*\)\s*type\b"
)
ZIG_PUB_CONST = re.compile(r"^(?P<indent>\s*)pub\s+(?:const|var)\s+(?P<name>[A-Za-z_]\w*)\b")
ZIG_EXPORT_VAR = re.compile(r"^(?P<indent>\s*)export\s+(?:const|var)\s+(?P<name>[A-Za-z_]\w*)\b")
ZIG_TEST = re.compile(r'^(?P<indent>\s*)test\s+(?:"(?P<name>[^"]*)"|(?P<ident>\w+))?\s*\{')
JS_FN = re.compile(
    r"^(?P<indent>\s*)(?P<vis>export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s*(?P<name>[A-Za-z_$][\w$]*)\s*\("
)
JS_ARROW = re.compile(
    r"^(?P<indent>\s*)(?P<vis>export\s+)?(?:const|let)\s+(?P<name>[A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)"
)
JS_CLASS = re.compile(r"^(?P<indent>\s*)(?P<vis>export\s+(?:default\s+)?)?class\s+(?P<name>[A-Za-z_$][\w$]*)")
JS_METHOD = re.compile(
    r"^(?P<indent>\s+)(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?\*?(?P<name>#?[A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{\s*$"
)
JS_EXPORT_LIST = re.compile(r"^\s*export\s*\{(?P<names>[^}]*)\}")
JS_KEYWORDS = {"if", "for", "while", "switch", "catch", "function", "return", "with"}
IDENT = re.compile(r"[A-Za-z_$][\w$]*")
AMBIGUOUS_DEFINITIONS = 6
AMBIGUOUS_REFERENCES = 40

TEST_SUPPORT_PATTERNS = (
    re.compile(r"(^|/)tests?/"),
    re.compile(r"_tests?\.zig$"),
    re.compile(r"(^|/)test_[\w-]+\.(zig|mjs|js|py)$"),
    re.compile(r"_test_controls\.zig$"),
    re.compile(r"_test_exports\.zig$"),
    re.compile(r"(^|/)terminal_client_fixture\.zig$"),
    re.compile(r"\.test\.ts$"),
)


@dataclasses.dataclass(frozen=True)
class Rule:
    prefix: str
    capability: str
    owner: str
    disposition: str
    note: str


@dataclasses.dataclass
class Symbol:
    path: str
    line: int
    qualified: str
    name: str
    kind: str
    visibility: str
    signature: str
    tested_in_file: bool = False


def git_files() -> list[str]:
    out = subprocess.run(
        ["git", "ls-files", "-z"], cwd=ROOT, check=True, capture_output=True
    ).stdout
    return sorted(p for p in out.decode().split("\0") if p and not p.startswith(SELF_PREFIX))


def load_rules() -> list[Rule]:
    rules: list[Rule] = []
    for raw in RULES.read_text().splitlines():
        if not raw.strip() or raw.startswith("#"):
            continue
        cols = raw.split("\t")
        if cols[0] == "prefix":
            continue
        if len(cols) == 4:
            cols.append("")
        if len(cols) != 5:
            raise SystemExit(f"ownership_rules.tsv: expected 4 or 5 columns: {raw!r}")
        rules.append(Rule(*cols))
    # Longest prefix wins so a specific file rule overrides its directory rule.
    return sorted(rules, key=lambda r: len(r.prefix), reverse=True)


def load_overrides() -> dict[str, list[tuple[str, tuple[str, str, str, str]]]]:
    """Maps path to [(symbol pattern, (capability, owner, disposition, note))]."""
    table: dict[str, list[tuple[str, tuple[str, str, str, str]]]] = collections.defaultdict(list)
    for raw in OVERRIDES.read_text().splitlines():
        if not raw.strip() or raw.startswith("#"):
            continue
        cols = raw.split("\t")
        if cols[0] == "path":
            continue
        while len(cols) < 6:
            cols.append("")
        table[cols[0]].append((cols[1], (cols[2], cols[3], cols[4], cols[5])))
    return table


def match_override(table, path: str, qualified: str):
    best = None
    for pattern, value in table.get(path, ()):
        if pattern.endswith(".*"):
            base = pattern[:-2]
            hit = qualified == base or qualified.startswith(base + ".")
        else:
            hit = qualified == pattern
        if hit and (best is None or len(pattern) > len(best[0])):
            best = (pattern, value)
    return best


def classify(path: str, rules: list[Rule]) -> Rule | None:
    for rule in rules:
        if path == rule.prefix or path.startswith(rule.prefix):
            return rule
    return None


def file_kind(path: str) -> str:
    if any(p.search(path) for p in TEST_SUPPORT_PATTERNS):
        return "test"
    if path.startswith(".github/"):
        return "ci"
    if path.endswith(".zig"):
        return "zig"
    if path.endswith((".js", ".mjs")):
        return "js"
    if path.endswith(".ts"):
        return "ts"
    if path.endswith(".rs"):
        return "rust"
    if path.endswith(".py") or path.endswith(".sh"):
        return "script"
    if path.endswith((".md", ".html")) or path == "LICENSE":
        return "doc"
    if path.endswith((".json", ".zon", ".yml", ".yaml", ".toml", ".lock", ".txt")) or path.endswith(".gitignore"):
        return "config"
    return "data"


def read_text(path: str) -> str | None:
    data = (ROOT / path).read_bytes()
    if b"\0" in data[:4096]:
        return None
    return data.decode("utf-8", errors="replace")


def scan_zig(path: str, lines: list[str]) -> tuple[list[Symbol], int, int, set[str]]:
    """Returns production symbols, test block count, test-local decl count, test tokens."""
    symbols: list[Symbol] = []
    stack: list[tuple[int, str, bool]] = []  # (indent, name, is_test_scope)
    tests = 0
    test_local = 0
    test_tokens: set[str] = set()
    for idx, line in enumerate(lines, start=1):
        stripped = line.strip()
        if not stripped or stripped.startswith("//"):
            continue
        indent = len(line) - len(line.lstrip(" "))
        if stripped.startswith("}"):
            while stack and stack[-1][0] >= indent:
                stack.pop()
            continue
        in_test = any(s[2] for s in stack)
        if in_test:
            test_tokens.update(IDENT.findall(line))
        m = ZIG_TEST.match(line)
        if m:
            tests += 1
            while stack and stack[-1][0] >= indent:
                stack.pop()
            stack.append((indent, f"test:{m.group('name') or m.group('ident') or ''}", True))
            continue
        for regex, kind in ((ZIG_GENERIC, "generic"), (ZIG_FN, "fn"), (ZIG_TYPE, "type")):
            m = regex.match(line)
            if not m:
                continue
            while stack and stack[-1][0] >= indent:
                stack.pop()
            name = m.group("name").strip('@"')
            in_test = any(s[2] for s in stack)
            container = ".".join(s[1] for s in stack if not s[1].startswith("test:"))
            qualified = f"{container}.{name}" if container else name
            if kind == "type":
                kind = m.group("kind")
            vis = "private"
            mods = m.groupdict().get("mods") or ""
            if "export" in mods:
                vis = "export"
            elif "extern" in mods:
                vis = "extern"
            elif m.group("vis"):
                vis = "pub"
            opens = stripped.endswith("{") or kind in ("struct", "enum", "union", "opaque", "error", "generic")
            if in_test:
                test_local += 1
            else:
                symbols.append(
                    Symbol(path, idx, qualified, name, kind, vis, " ".join(stripped.split())[:160])
                )
            if opens:
                stack.append((indent, name, in_test))
            break
        else:
            m = ZIG_EXPORT_VAR.match(line) or ZIG_PUB_CONST.match(line)
            if m and not in_test and not ZIG_TYPE.match(line):
                vis = "export" if stripped.startswith("export") else "pub"
                container = ".".join(s[1] for s in stack if not s[1].startswith("test:"))
                if container and indent == 0:
                    container = ""
                name = m.group("name")
                qualified = f"{container}.{name}" if container else name
                symbols.append(
                    Symbol(path, idx, qualified, name, "const", vis, " ".join(stripped.split())[:160])
                )
    return symbols, tests, test_local, test_tokens


def scan_js(path: str, lines: list[str]) -> list[Symbol]:
    symbols: list[Symbol] = []
    exported: set[str] = set()
    for line in lines:
        m = JS_EXPORT_LIST.match(line)
        if m:
            for part in m.group("names").split(","):
                part = part.strip()
                if part:
                    exported.add(part.split(" as ")[-1].strip())
    current_class: tuple[int, str] | None = None
    for idx, line in enumerate(lines, start=1):
        stripped = line.strip()
        if not stripped or stripped.startswith("//") or stripped.startswith("*"):
            continue
        indent = len(line) - len(line.lstrip(" "))
        if current_class and indent <= current_class[0] and stripped.startswith("}"):
            current_class = None
            continue
        for regex, kind in ((JS_CLASS, "class"), (JS_FN, "fn"), (JS_ARROW, "fn")):
            m = regex.match(line)
            if m:
                name = m.group("name")
                if indent > 2 and kind == "fn" and regex is JS_ARROW:
                    break  # local closures are implementation detail of their parent
                vis = "export" if (m.group("vis") or name in exported) else "module"
                qualified = name
                if current_class and indent > current_class[0]:
                    qualified = f"{current_class[1]}.{name}"
                symbols.append(Symbol(path, idx, qualified, name, kind, vis, " ".join(stripped.split())[:160]))
                if kind == "class":
                    current_class = (indent, name)
                break
        else:
            m = JS_METHOD.match(line)
            if m and current_class and indent == current_class[0] + 2 and m.group("name") not in JS_KEYWORDS:
                name = m.group("name")
                symbols.append(
                    Symbol(path, idx, f"{current_class[1]}.{name}", name, "method",
                           "private" if name.startswith("#") else "member",
                           " ".join(stripped.split())[:160])
                )
    return symbols


AUDIT_BY_CAPABILITY = (
    ("INF-", "audit/01-inference-path.md"),
    ("OBS-", "audit/05-product-shell.md"),
    ("SHR-SECRET", "audit/02-auth-config-hosts.md"),
    ("SHR-", "audit/05-product-shell.md"),
    ("PRV-", "audit/02-auth-config-hosts.md"),
    ("PRD-UPGRADE", "audit/02-auth-config-hosts.md"),
    ("PRD-FEEDBACK", "audit/02-auth-config-hosts.md"),
    ("PRD-CONFIG", "audit/02-auth-config-hosts.md"),
    ("PRD-", "audit/05-product-shell.md"),
    ("EXE-REMOTE", "audit/02-auth-config-hosts.md"),
    ("EXE-", "audit/03-agent-tools-execution.md"),
    ("AGT-", "audit/03-agent-tools-execution.md"),
    ("EMB-HOST", "audit/02-auth-config-hosts.md"),
    ("EMB-", "audit/04-embedding-build-ci.md"),
    ("OPS-", "audit/04-embedding-build-ci.md"),
    ("DOC", "VERCEL_TRACE.md"),
)


def review_status(capability: str, path: str = "") -> str:
    """Names the audit note whose pass covered this file's area."""
    if path.startswith("rust/") or path == "rust-toolchain.toml" or path.endswith("rust-core.yml"):
        return "BEHAVIOR_MATRIX.md §8-10 (R1 contract, R2 executor and R3 adapter tests)"
    for prefix, doc in AUDIT_BY_CAPABILITY:
        if capability.startswith(prefix):
            return doc
    return "unreviewed"


def language(path: str) -> str:
    """Lexical references only count within one language family."""
    if path.endswith(".zig"):
        return "zig"
    if path.endswith((".js", ".mjs", ".ts", ".html")):
        return "js"
    return "other"


def tsv_escape(value: object) -> str:
    return str(value).replace("\t", " ").replace("\n", " ")


def generate() -> dict[str, str]:
    rules = load_rules()
    files = git_files()
    file_rows: list[list[object]] = []
    symbols: list[Symbol] = []
    unclassified: list[str] = []
    tokens_by_file: dict[str, set[str]] = {}
    test_counts: dict[str, int] = {}
    for path in files:
        rule = classify(path, rules)
        if rule is None:
            unclassified.append(path)
        kind = file_kind(path)
        text = read_text(path)
        line_count = 0 if text is None else text.count("\n") + (0 if text.endswith("\n") or not text else 1)
        decls = tests = local = 0
        if text is not None and path.endswith((".zig", ".js", ".mjs", ".ts", ".html")):
            tokens_by_file[path] = set(IDENT.findall(text))
        if text is not None and path.endswith(".zig"):
            lines = text.splitlines()
            syms, tests, local, test_tokens = scan_zig(path, lines)
            for s in syms:
                s.tested_in_file = s.name in test_tokens
            if kind == "test":
                local += len(syms)
                syms = []
            symbols.extend(syms)
            decls = len(syms)
        elif text is not None and path.endswith((".js", ".mjs")) and kind != "test":
            syms = scan_js(path, text.splitlines())
            symbols.extend(syms)
            decls = len(syms)
        elif text is not None and path.endswith((".mjs", ".ts", ".js")):
            tests = len(re.findall(
                r"^\s*(?:test|it|[a-z]\w*Test)(?:\.\w+(?:\((?:[^()]|\([^()]*\))*\))?)*\(\s*[\"'`]", text, re.M))
            if not tests and pathlib.PurePosixPath(path).name.startswith("test-"):
                tests = 1  # standalone scenario script: one pass/fail result per file
        elif text is not None and path.endswith(".rs"):
            # The Rust core is new code, inventoried by its own test map
            # (BEHAVIOR_MATRIX.md §8); only its tests are counted here.
            tests = len(re.findall(r"^\s*#\[test\]", text, re.M))
        elif text is not None and path.endswith(".py"):
            tests = len(re.findall(r"^\s*def test_\w+", text, re.M))
        test_counts[path] = tests
        purpose = ""
        if text is not None:
            header = [ln[3:].strip() for ln in text.splitlines()[:12] if ln.startswith("//!")]
            purpose = " ".join(header)[:160]
        if not purpose and rule:
            purpose = rule.note
        key_decls = ",".join(
            sym.qualified for sym in symbols
            if sym.path == path and sym.visibility in ("pub", "export") and "." not in sym.qualified
        )
        file_rows.append([
            path, kind, "binary" if text is None else line_count, decls, tests, local,
            rule.capability if rule else "UNCLASSIFIED",
            rule.owner if rule else "UNCLASSIFIED",
            rule.disposition if rule else "UNCLASSIFIED",
            rule.prefix if rule else "",
            review_status(rule.capability if rule else "", path),
            purpose,
            ",".join(key_decls.split(",")[:6]),
        ])

    definitions = collections.Counter()
    defining_files: dict[str, set[str]] = collections.defaultdict(set)
    for s in symbols:
        defining_files[s.name].add(s.path)
    for name, paths in defining_files.items():
        definitions[name] = len(paths)
    referencing: dict[tuple[str, str], list[str]] = collections.defaultdict(list)
    names = set(defining_files)
    for path, toks in tokens_by_file.items():
        lang = language(path)
        for name in toks & names:
            referencing[(lang, name)].append(path)

    overrides = load_overrides()
    used_overrides: set[tuple[str, str]] = set()
    sym_rows: list[list[object]] = []
    for s in symbols:
        rule = classify(s.path, rules)
        cap = rule.capability if rule else "UNCLASSIFIED"
        owner = rule.owner if rule else "UNCLASSIFIED"
        disp = rule.disposition if rule else "UNCLASSIFIED"
        source = "rule"
        hit = match_override(overrides, s.path, s.qualified)
        if hit:
            used_overrides.add((s.path, hit[0]))
            cap, owner, disp = hit[1][0], hit[1][1], hit[1][2]
            source = "override"
        others = sorted(p for p in referencing[(language(s.path), s.name)] if p != s.path)
        if definitions[s.name] >= AMBIGUOUS_DEFINITIONS or len(others) > AMBIGUOUS_REFERENCES:
            callers = "ambiguous"
            sample = ""
        else:
            callers = str(len(others))
            sample = ",".join(others[:3])
        sym_rows.append([
            s.path, s.line, s.qualified, s.kind, s.visibility,
            callers, sample, "yes" if s.tested_in_file else "no",
            cap, owner, disp, source,
            s.signature,
        ])

    outputs: dict[str, str] = {}
    header = ["path", "kind", "lines", "production_decls", "tests", "test_local_decls",
              "capability", "owner", "disposition", "rule_prefix", "review", "purpose", "key_public_decls"]
    outputs["files.tsv"] = "\n".join(
        "\t".join(tsv_escape(c) for c in row) for row in [header, *file_rows]
    ) + "\n"
    sym_header = ["path", "line", "symbol", "kind", "visibility", "external_ref_files",
                  "ref_sample", "named_in_file_tests", "capability", "owner", "disposition",
                  "disposition_source", "signature"]
    outputs["symbols.tsv"] = "\n".join(
        "\t".join(tsv_escape(c) for c in row) for row in [sym_header, *sym_rows]
    ) + "\n"
    stale_overrides = sorted(
        f"{path} {pattern}" for path, entries in overrides.items() for pattern, _ in entries
        if (path, pattern) not in used_overrides
    )
    outputs["summary.md"] = render_summary(file_rows, sym_rows, unclassified, rules, stale_overrides)
    return outputs


def render_summary(file_rows, sym_rows, unclassified, rules, stale_overrides) -> str:
    by_rule = collections.OrderedDict()
    for r in sorted(rules, key=lambda r: r.prefix):
        by_rule[r.prefix] = [r, 0, 0, 0, 0]
    for row in file_rows:
        entry = by_rule.get(row[9])
        if entry is None:
            continue
        entry[1] += 1
        entry[2] += row[2] if isinstance(row[2], int) else 0
        entry[4] += row[4]
    for row in sym_rows:
        rule = None
        for r in rules:
            if row[0] == r.prefix or row[0].startswith(r.prefix):
                rule = r
                break
        if rule:
            by_rule[rule.prefix][3] += 1
    owner_totals = collections.Counter()
    disp_totals = collections.Counter()
    owner_lines = collections.Counter()
    for row in file_rows:
        owner_totals[row[7]] += 1
        disp_totals[row[8]] += 1
        owner_lines[row[7]] += row[2] if isinstance(row[2], int) else 0
    sym_owner = collections.Counter(row[9] for row in sym_rows)
    sym_disp = collections.Counter(row[10] for row in sym_rows)
    sym_kind = collections.Counter(row[3] for row in sym_rows)
    sym_vis = collections.Counter(row[4] for row in sym_rows)
    zero_ref_pub = sum(1 for row in sym_rows if row[4] in ("pub", "export") and row[5] == "0")
    out = [
        "# Generated inventory summary",
        "",
        "Generated by `docs/rebuild/tools/generate_inventory.py`. Do not edit by hand.",
        "",
        f"- Tracked files inventoried: {len(file_rows)} (excluding `{SELF_PREFIX}` itself)",
        f"- Unclassified files: {len(unclassified)}",
        f"- Production declarations: {len(sym_rows)}",
        f"- Test blocks and test cases: {sum(r[4] for r in file_rows)}",
        f"- Test-local declarations (not listed individually): {sum(r[5] for r in file_rows)}",
        f"- `pub`/`export` declarations with zero lexical references outside their file: {zero_ref_pub}",
        "",
        "## Declarations by kind",
        "",
        "| Kind | Count |",
        "| --- | ---: |",
        *[f"| {k} | {v} |" for k, v in sorted(sym_kind.items())],
        "",
        "## Declarations by visibility",
        "",
        "| Visibility | Count |",
        "| --- | ---: |",
        *[f"| {k} | {v} |" for k, v in sorted(sym_vis.items())],
        "",
        "## Files and lines by proposed owner",
        "",
        "| Owner | Files | Lines | Production declarations |",
        "| --- | ---: | ---: | ---: |",
        *[f"| {k} | {owner_totals[k]} | {owner_lines[k]} | {sym_owner.get(k, 0)} |" for k in sorted(owner_totals)],
        "",
        "## Files by disposition",
        "",
        "| Disposition | Files | Production declarations |",
        "| --- | ---: | ---: |",
        *[f"| {k} | {disp_totals[k]} | {sym_disp.get(k, 0)} |" for k in sorted(disp_totals)],
        "",
        "## Rules",
        "",
        "| Rule prefix | Capability | Owner | Disposition | Files | Lines | Declarations | Tests |",
        "| --- | --- | --- | --- | ---: | ---: | ---: | ---: |",
    ]
    for prefix, (rule, nfiles, nlines, ndecls, ntests) in by_rule.items():
        out.append(
            f"| `{prefix}` | {rule.capability} | {rule.owner} | {rule.disposition} | {nfiles} | {nlines} | {ndecls} | {ntests} |"
        )
    unused = [p for p, e in by_rule.items() if e[1] == 0]
    out += ["", "## Rules that match no file", ""]
    out += [f"- `{p}`" for p in unused] or ["None."]
    overridden = sum(1 for row in sym_rows if row[11] == "override")
    out += ["", f"## Symbol overrides ({overridden} declarations refined by `symbol_overrides.tsv`)", ""]
    out += ["Overrides that match no declaration:", ""]
    out += [f"- `{p}`" for p in stale_overrides] or ["None."]
    out += ["", "## Unclassified files", ""]
    out += [f"- `{p}`" for p in unclassified] or ["None."]
    return "\n".join(out) + "\n"


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="fail when outputs are stale or a file is unclassified")
    args = parser.parse_args(argv)
    outputs = generate()
    unclassified = outputs["summary.md"].split("## Unclassified files", 1)[1].strip()
    if args.check:
        stale = [name for name, text in outputs.items() if not (OUT / name).exists() or (OUT / name).read_text() != text]
        if stale:
            print(f"stale inventory outputs: {', '.join(stale)}", file=sys.stderr)
            return 1
        if "\tunreviewed\t" in outputs["files.tsv"]:
            print("files without a covering audit remain", file=sys.stderr)
            return 1
        if unclassified != "None.":
            print("unclassified files remain", file=sys.stderr)
            return 1
        defined = set(re.findall(r"^\| `([A-Z]+-[A-Z0-9-]+|DOC)` \|", LEDGER.read_text(), re.M))
        used = {r.capability for r in load_rules()} | {
            v[0] for entries in load_overrides().values() for _, v in entries
        }
        undefined = sorted(used - defined)
        if undefined:
            print(f"capability IDs missing from CAPABILITIES.md: {', '.join(undefined)}", file=sys.stderr)
            return 1
        stale = outputs["summary.md"].split("Overrides that match no declaration:", 1)[1].split("##", 1)[0].strip()
        if stale != "None.":
            print("symbol overrides match no declaration", file=sys.stderr)
            return 1
        return 0
    OUT.mkdir(parents=True, exist_ok=True)
    for name, text in outputs.items():
        (OUT / name).write_text(text)
    print(outputs["summary.md"].split("## Declarations by kind", 1)[0].strip())
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
