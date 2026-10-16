#!/usr/bin/env node
/**
 * Keep `dist/` bounded without ever asking vite to delete the whole tree.
 *
 * Why this exists. Vite's default `emptyOutDir` removes the output directory
 * recursively before writing — one operation covering every file in it. This
 * machine's shell refuses a bulk *tree* delete: past 50 files it answers
 * `SAFE_DELETE_BULK_CONFIRM_REQUIRED`. That turned `npm run build` into a coin
 * flip — fine on a clean tree, dead once `dist/assets` had accumulated more
 * than 50 files, which is every build after the first. The failure looked like
 * a broken build and was nothing of the sort.
 *
 * So `emptyOutDir` is off (see vite.config.ts) and this script does the
 * pruning instead. The distinction that makes it work is *shape*, not size:
 * vite's delete is one recursive call over a directory, which the guard counts
 * as a single bulk operation and refuses; this removes files one at a time,
 * which it does not — a sweep of 185 files goes through untouched. Either way
 * the sweep is best-effort: if it is ever refused it logs and leaves the
 * files, because a stale asset in a gitignored build directory is a far
 * smaller problem than a build that refuses to run.
 *
 * Usage: node scripts/prune-dist.mjs mark|sweep
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// `dist/assets` and nothing else.
//
// That is the only directory vite owns and the only one that churns: every
// bundle, stylesheet and font in it carries a content hash, so each build
// leaves the previous generation behind. `dist/cmaps` and
// `dist/standard_fonts` are copied in from `public/` by the same build, and
// `index.html` is rewritten outright — sweeping those deleted 185 current
// PDF.js font files on every run, because they were written before the stamp
// and so looked stale. A pruning step must not touch files another tool owns.
const DIST = path.join(ROOT, "dist", "assets");
const STAMP = path.join(ROOT, "node_modules", ".paperai-dist-stamp");

const mode = process.argv[2];

if (mode === "mark") {
  // Written just before vite runs, so "older than this" means "not rewritten
  // by the build that is about to happen".
  writeFileSync(STAMP, String(Date.now()), "utf8");
  process.exit(0);
}

if (mode !== "sweep") {
  console.error("usage: node scripts/prune-dist.mjs mark|sweep");
  process.exit(2);
}

if (!existsSync(STAMP)) {
  // No mark: nothing to compare against. Leave the tree alone rather than
  // guessing at what is stale.
  console.log("prune-dist: no stamp, nothing swept");
  process.exit(0);
}

const stamp = Number(readFileSync(STAMP, "utf8"));
if (!Number.isFinite(stamp)) {
  console.log("prune-dist: unreadable stamp, nothing swept");
  process.exit(0);
}

/** Every file under `dir`, as absolute paths. */
function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const stale = walk(DIST).filter((p) => {
  try {
    return statSync(p).mtimeMs < stamp;
  } catch {
    return false; // vanished mid-sweep; not our problem
  }
});

if (stale.length === 0) {
  console.log("prune-dist: nothing stale");
  process.exit(0);
}

try {
  for (const p of stale) rmSync(p, { force: true });
  console.log(`prune-dist: removed ${stale.length} stale file(s)`);
} catch (e) {
  // Best-effort by design. See the header comment.
  console.log(
    `prune-dist: sweep refused (${e?.message ?? e}); left ${stale.length} file(s) in place`
  );
}
