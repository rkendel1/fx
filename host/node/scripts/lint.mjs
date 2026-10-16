// @ts-check
// Lint for the host package: syntax of every file, plus the policy that keeps the bridge
// free of ambient authority. There is deliberately no linter dependency; these checks
// are the ones this package needs.

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

/** @param {string} dir @returns {string[]} */
function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules") return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(m?js)$/.test(name) ? [path] : [];
  });
}

/** Source that ships must not reach the environment, processes, the network or the clock of the host. */
/** @type {Array<[RegExp, string]>} */
const SHIPPED_BANNED = [
  [/process\.env/, "reads the environment"],
  [/child_process/, "spawns processes"],
  [/node:(net|http|https|dgram|tls|dns|worker_threads|cluster|vm)\b/, "reaches the network or runs code"],
  [/\beval\s*\(|new Function\s*\(/, "evaluates code"],
  [/\bconsole\./, "writes to the console"],
  [/\bfetch\s*\(/, "performs network I/O (the provider layer does that)"],
];
/** Files allowed to touch the filesystem, and how. */
/** @type {Map<string, RegExp>} */
const FS_ALLOWED = new Map([["src/wasm.js", /node:fs\/promises/]]);

const problems = [];
for (const file of files(root)) {
  const rel = relative(root, file);
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (error) {
    problems.push(`${rel}: syntax error\n${/** @type {any} */ (error).stderr}`);
    continue;
  }
  const text = readFileSync(file, "utf8");
  if (/\t/.test(text)) problems.push(`${rel}: contains a tab`);
  if (/[ ]+$/m.test(text)) problems.push(`${rel}: trailing whitespace`);
  if (!rel.startsWith("src/")) continue;
  for (const [pattern, why] of SHIPPED_BANNED) {
    if (pattern.test(text)) problems.push(`${rel}: ${why}`);
  }
  for (const match of text.matchAll(/from "(node:fs[^"]*|fs[^"]*)"/g)) {
    const allowed = FS_ALLOWED.get(rel);
    if (!allowed || !allowed.test(match[1])) problems.push(`${rel}: imports ${match[1]}`);
  }
}

if (problems.length > 0) {
  process.stderr.write(`lint failed:\n${problems.map((p) => `  ${p}`).join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`lint ok (${files(root).length} files)\n`);
