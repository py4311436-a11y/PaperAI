/**
 * Compiles the AI modules for testing and runs both unit suites.
 *
 * Why a compile step: the tests exercise the real `src/ai/*.ts` sources, not a
 * copy, so they cannot drift. Node cannot import TypeScript, and the release
 * bundler output is minified, so a dedicated `tsc -p tsconfig.test.json` keeps
 * both honest.
 *
 * Usage: node scripts/run-ai-unit-tests.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const EVIDENCE = path.join(ROOT, "evidence", "ai-tests");
mkdirSync(EVIDENCE, { recursive: true });

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", shell: false, ...opts });
  return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}

console.log("--- compile (tsc -p tsconfig.test.json) ---");
rmSync(path.join(ROOT, "dist-test"), { recursive: true, force: true });
// Invoke tsc through Node rather than `npx`: on Windows npx is a .cmd shim and
// cannot be spawned with shell:false, and shell:true would re-introduce quoting
// problems with the project path.
const TSC = path.join(ROOT, "node_modules", "typescript", "bin", "tsc");
if (!existsSync(TSC)) {
  console.log("BLOCKED: typescript is not installed (run npm ci)");
  process.exit(1);
}
const tsc = run(process.execPath, [TSC, "-p", "tsconfig.test.json"]);
if (tsc.code !== 0) {
  console.log(tsc.out);
  console.log("BLOCKED: the test build did not compile");
  process.exit(1);
}
if (!existsSync(path.join(ROOT, "dist-test/src/ai/markdown-renderer.js"))) {
  console.log("BLOCKED: expected compiled output is missing");
  process.exit(1);
}
console.log("compiled OK");

const suites = [
  { name: "context + chat controller", file: "dist-test/tests/ai-unit/run.js" },
  { name: "markdown safety", file: "tests/ai-unit/markdown.test.mjs" },
  { name: "panel provider/model picker", file: "tests/ai-unit/panel-picker.test.mjs" },
  { name: "interrupted answer (A-16)", file: "tests/ai-unit/interrupted-answer.test.mjs" },
  { name: "eraser policy (A-18)", file: "tests/ai-unit/erase-policy.test.mjs" },
  { name: "reading memory chunking (A-19)", file: "tests/ai-unit/memory.test.mjs" },
  { name: "page text extraction (A-26)", file: "tests/ai-unit/text-extraction.test.mjs" },
  { name: "ctrl+wheel zoom", file: "tests/ai-unit/wheel-zoom.test.mjs" },
];

const results = [];
for (const s of suites) {
  const r = run("node", ["--test", s.file]);
  const pass = Number(/^# pass (\d+)$/m.exec(r.out)?.[1] ?? 0);
  const fail = Number(/^# fail (\d+)$/m.exec(r.out)?.[1] ?? 0);
  const total = Number(/^# tests (\d+)$/m.exec(r.out)?.[1] ?? 0);
  results.push({ ...s, pass, fail, total, ok: fail === 0 && total > 0 });
  console.log(`[${(fail === 0 && total > 0 ? "PASS" : "FAIL").padEnd(8)}] ${s.name}: ${pass}/${total}`);
  if (fail > 0) {
    console.log(
      r.out
        .split(/\r?\n/)
        .filter((l) => /^not ok|AssertionError|error:/.test(l))
        .slice(0, 12)
        .map((l) => "            " + l.trim())
        .join("\n")
    );
  }
}

const pass = results.reduce((n, r) => n + r.pass, 0);
const total = results.reduce((n, r) => n + r.total, 0);

writeFileSync(
  path.join(EVIDENCE, "ai-unit-RESULTS.md"),
  [
    "# Frontend AI unit tests",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Runner: scripts/run-ai-unit-tests.mjs (compiles src/ai/*.ts with tsc, then node --test)`,
    `Compiled from: src/ai/context-builder.ts, chat-controller.ts, markdown-renderer.ts, types.ts`,
    "",
    "| Suite | Pass | Total |",
    "|---|---|---|",
    ...results.map((r) => `| ${r.name} | ${r.pass} | ${r.total} |`),
    "",
    `**${pass}/${total} PASS**`,
    "",
    "These tests import the real sources, so they cannot drift from the shipped code.",
    "",
  ].join("\n"),
  "utf8"
);

console.log(`\n${pass}/${total} PASS — evidence in evidence/ai-tests/`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
