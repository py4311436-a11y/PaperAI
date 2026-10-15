/**
 * Frontend build entry with an explicit flavour.
 *
 *   node scripts/build.mjs --release      -> no test bridge (K-03)
 *   node scripts/build.mjs --automation   -> keeps window.__paperai, for tests
 *
 * Why not inline `VITE_PAPERAI_AUTOMATION=1 vite build` in package.json: that
 * syntax is not portable to cmd.exe, and adding `cross-env` just to set one
 * variable is a dependency we do not need.
 *
 * The flag is consumed by `src/main.ts` as a *statically known* constant, so
 * Rollup can tree-shake the whole test-bridge block out of a release bundle.
 * `scripts/verify-release-bundle.mjs` asserts that it really is gone.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

const arg = process.argv[2];
if (arg !== "--release" && arg !== "--automation") {
  console.error("usage: node scripts/build.mjs --release | --automation");
  process.exit(2);
}
const automation = arg === "--automation";

// 1. PDF.js assets must be in place before Vite copies them.
const sync = spawnSync(process.execPath, [path.join(ROOT, "scripts", "sync-pdfjs-assets.mjs")], {
  cwd: ROOT,
  stdio: "inherit",
});
if (sync.status !== 0) {
  console.error("asset sync failed");
  process.exit(sync.status ?? 1);
}

// 2. Type-check (same as the normal build).
const TSC = path.join(ROOT, "node_modules", "typescript", "bin", "tsc");
const tsc = spawnSync(process.execPath, [TSC, "--noEmit"], { cwd: ROOT, stdio: "inherit" });
if (tsc.status !== 0) {
  console.error("type check failed");
  process.exit(tsc.status ?? 1);
}

// 3. Bundle with the flag pinned.
//
// Vite empties `outDir` by default, and the installer lives in `dist/installer`
// — so a plain rebuild silently DELETED the shipped setup.exe. That happened
// once during this round and the artefact had to be recovered from the Cargo
// target directory. Preserve it explicitly rather than relying on the operator
// to remember.
const installerDir = path.join(ROOT, "dist", "installer");
// NOTE: the stash must live OUTSIDE dist/. Vite's emptyOutDir removes the whole
// directory tree, so a stash inside it is deleted along with the installer —
// which is exactly the bug this code exists to prevent.
const stash = path.join(ROOT, ".installer-stash");
let preserved = [];
if (existsSync(installerDir)) {
  mkdirSync(stash, { recursive: true });
  for (const f of readdirSync(installerDir)) {
    renameSync(path.join(installerDir, f), path.join(stash, f));
    preserved.push(f);
  }
}

const vite = path.join(ROOT, "node_modules", "vite", "bin", "vite.js");
const r = spawnSync(process.execPath, [vite, "build"], {
  cwd: ROOT,
  stdio: "inherit",
  env: {
    ...process.env,
    VITE_PAPERAI_AUTOMATION: automation ? "1" : "0",
  },
});

if (preserved.length) {
  mkdirSync(installerDir, { recursive: true });
  for (const f of preserved) {
    renameSync(path.join(stash, f), path.join(installerDir, f));
  }
  rmdirSync(stash, { recursive: true, force: true });
  console.log(`preserved ${preserved.length} installer(s) in dist/installer/`);
}

if (r.status !== 0) process.exit(r.status ?? 1);

console.log(`\nbuilt flavour: ${automation ? "automation (test bridge PRESENT)" : "release (test bridge ABSENT)"}`);
