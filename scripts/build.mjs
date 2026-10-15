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
 *
 * ---------------------------------------------------------------------------
 * `dist/` IS NOT A DELIVERY FOLDER.
 *
 * `tauri.conf.json` sets `frontendDist: "../dist"`, so EVERYTHING in `dist/` is
 * embedded into the binary and therefore into the setup.exe. Storing the shipped
 * installer in `dist/installer/` once produced a build where 0.3.1 shipped with
 * 0.2.0 and 0.3.0 nested inside it — 22.25 MiB instead of 5.5 MiB, and growing
 * with every release. Setup files now live in `release/`, and the guard below
 * fails the build if anything unexpected appears in `dist/`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

const arg = process.argv[2];
if (arg !== "--release" && arg !== "--automation") {
  console.error("usage: node scripts/build.mjs --release | --automation");
  process.exit(2);
}
const automation = arg === "--automation";

/**
 * The only entries `dist/` may contain after a build.
 *
 * `assets/` and `index.html` come from Vite; `cmaps/` and `standard_fonts/`
 * are vendored PDF.js assets copied out of `public/`. Anything else means
 * someone put a non-frontend file where the bundler will pick it up.
 */
const ALLOWED_DIST_ENTRIES = new Set(["assets", "index.html", "cmaps", "standard_fonts"]);

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

// 3. Bundle with the flag pinned. Vite empties outDir itself.
const vite = path.join(ROOT, "node_modules", "vite", "bin", "vite.js");
const r = spawnSync(process.execPath, [vite, "build"], {
  cwd: ROOT,
  stdio: "inherit",
  env: {
    ...process.env,
    VITE_PAPERAI_AUTOMATION: automation ? "1" : "0",
  },
});
if (r.status !== 0) process.exit(r.status ?? 1);

// 4. Guard: nothing but frontend assets may sit in dist/.
const dist = path.join(ROOT, "dist");
const strays = existsSync(dist)
  ? readdirSync(dist).filter((e) => !ALLOWED_DIST_ENTRIES.has(e))
  : [];
if (strays.length) {
  console.error(
    `\nREFUSING TO CONTINUE: dist/ contains entries that are not frontend assets:\n` +
      strays.map((s) => `  dist/${s}`).join("\n") +
      `\n\n` +
      `tauri.conf.json sets frontendDist to "../dist", so anything here is embedded\n` +
      `into the setup.exe. Move it to release/ (see scripts/collect-release.mjs), or\n` +
      `add it to ALLOWED_DIST_ENTRIES in this file if it genuinely belongs in the\n` +
      `bundle.`
  );
  process.exit(1);
}

console.log(`\nbuilt flavour: ${automation ? "automation (test bridge PRESENT)" : "release (test bridge ABSENT)"}`);
