/**
 * Asserts that the K-03 requirement actually holds in the built bundle.
 *
 * The requirement is not "the button is hidden" or "the code is unreachable" —
 * it is that a released artifact does not contain a callable test bridge at all.
 * The only honest way to check that is to look at the shipped JavaScript.
 *
 * Strategy: search every emitted asset for the identifiers that only exist in
 * the automation path. A minifier may rename locals, but it cannot remove a
 * *string literal* that the app evaluates, and `__paperai` is written as a
 * property name on `window`, which survives minification.
 *
 * Usage:
 *   node scripts/verify-release-bundle.mjs dist                 # expect ABSENT
 *   node scripts/verify-release-bundle.mjs dist --expect-present # expect PRESENT
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const dir = path.resolve(ROOT, process.argv[2] ?? "dist");
const expectPresent = process.argv.includes("--expect-present");

function walk(d, out = []) {
  for (const e of readdirSync(d)) {
    const p = path.join(d, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(js|mjs|html)$/.test(e)) out.push(p);
  }
  return out;
}

/**
 * Markers that only exist when the test bridge is compiled in.
 *
 * NOT included, and why:
 *   - `__paperai_ready` is a read-only boolean the shell sets so the automated
 *     desktop suites can tell "frontend booted" from "blank window". It exposes
 *     no callable surface.
 *   - `debugState` is a real adapter method that production code uses (the Erase
 *     button checks whether an annotation is selected). Its presence is not a
 *     bridge. That the *bridge* also exposes it is covered by the
 *     `window.__paperai` check below.
 *
 * Everything in the list is either the bridge object itself or a method that
 * exists solely for automation.
 */
const MARKERS = [
  "window.__paperai",
  "loadByArrayBuffer",
  "saveRequest",
  "getSpanRects",
  "__verifyLoaded",
  "__paperaiPickFile",
];

const files = walk(dir);
if (!files.length) {
  console.log(`BLOCKED: no JS/HTML assets under ${dir}`);
  process.exit(2);
}

const hits = [];
for (const f of files) {
  const text = readFileSync(f, "utf8");
  for (const m of MARKERS) {
    // `window.__paperai` must not match `window.__paperai_ready`.
    const re = new RegExp(
      m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + (m === "window.__paperai" ? "(?![_A-Za-z0-9])" : ""),
      "g"
    );
    const n = (text.match(re) ?? []).length;
    if (n > 0) hits.push({ file: path.relative(ROOT, f), marker: m, count: n });
  }
}

const present = hits.length > 0;
const ok = expectPresent ? present : !present;

console.log(`scanned ${files.length} asset(s) under ${path.relative(ROOT, dir)}`);
console.log(`test-bridge markers found: ${present ? hits.length : 0}`);
for (const h of hits.slice(0, 20)) console.log(`    ${h.marker}  in  ${h.file}`);
console.log("");
console.log(
  ok
    ? `PASS — ${expectPresent ? "automation build does contain" : "release build does NOT contain"} the test bridge`
    : `FAIL — ${expectPresent ? "automation build is missing the test bridge (tests would silently no-op)" : "release build STILL CONTAINS the test bridge (K-03 not fixed)"}`
);

process.exit(ok ? 0 : 1);
