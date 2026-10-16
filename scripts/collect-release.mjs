#!/usr/bin/env node
/**
 * Collect the built installer into release/ and print its size + SHA-256.
 *
 * Why this exists at all: the setup.exe used to be copied into `dist/installer/`
 * by hand. `dist/` is `frontendDist`, so the next `tauri build` embedded the
 * previous installers into the new one — 0.3.1 came out at 22.25 MiB because it
 * contained 0.2.0 and 0.3.0. Artifacts live in `release/`, which is outside
 * anything the bundler reads.
 *
 * Usage: node scripts/collect-release.mjs [version]
 */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

// Tauri puts the bundle next to the Cargo target dir, which this project keeps
// outside the source tree via CARGO_TARGET_DIR.
const BUNDLE_DIRS = [
  process.env.PAPERAI_BUNDLE_DIR,
  "D:/PaperAI-Build/target/release/bundle/nsis",
  path.join(ROOT, "src-tauri", "target", "release", "bundle", "nsis"),
].filter(Boolean);

const version =
  process.argv[2] ??
  JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(path.join(ROOT, "package.json"), "utf8")))
    .version;

const wanted = `PaperAI_${version}_x64-setup.exe`;

let src = null;
for (const dir of BUNDLE_DIRS) {
  const p = path.join(dir, wanted);
  if (existsSync(p)) {
    src = p;
    break;
  }
}
if (!src) {
  console.error(`not found: ${wanted}`);
  for (const dir of BUNDLE_DIRS) {
    if (!existsSync(dir)) continue;
    const have = readdirSync(dir).filter((f) => f.endsWith(".exe"));
    if (have.length) console.error(`  in ${dir}: ${have.join(", ")}`);
  }
  console.error(`\nBuild it first:  npx tauri build --config '{"build":{"beforeBuildCommand":""}}'`);
  process.exit(1);
}

const outDir = path.join(ROOT, "release");
mkdirSync(outDir, { recursive: true });
const dest = path.join(outDir, wanted);
copyFileSync(src, dest);

const bytes = statSync(dest).size;
const sha = createHash("sha256").update(await import("node:fs/promises").then((fs) => fs.readFile(dest))).digest("hex");

console.log(`copied : ${path.relative(ROOT, dest)}`);
console.log(`bytes  : ${bytes} (${(bytes / 1024 / 1024).toFixed(2)} MiB)`);
console.log(`sha256 : ${sha}`);

// Retire the previous installer from git.
//
// Only the current one is tracked — see the `release/*` negation in
// .gitignore, which names the version explicitly so a stray `git add -A`
// cannot sweep in the whole directory. That leaves one manual step: the
// installer committed for the *previous* version is still in the index, and
// forgetting to drop it is how the repository ends up carrying every build
// ever shipped, ~5 MiB each, forever.
//
// Done here rather than left to memory because the cost of getting it wrong is
// invisible at the time and permanent afterwards. The file stays on disk; this
// only untracks it, so the local archive is untouched.
{
  const { execFileSync } = await import("node:child_process");
  const tracked = execFileSync("git", ["ls-files", "release"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const stale = tracked.filter((f) => path.basename(f) !== wanted);
  for (const f of stale) {
    try {
      execFileSync("git", ["rm", "--cached", "--quiet", f], { cwd: ROOT, stdio: "pipe" });
      console.log(`untracked (superseded): ${path.relative(ROOT, f)}`);
    } catch (e) {
      // Not fatal: the file is simply still tracked. Say so loudly, because
      // silence here is what lets the repository grow.
      console.error(`WARNING: could not untrack ${f}: ${e.message ?? e}`);
    }
  }
}


// A sanity bound. Anything far above this almost certainly means something was
// bundled that should not have been.
const SOFT_LIMIT = 12 * 1024 * 1024;
if (bytes > SOFT_LIMIT) {
  console.error(
    `\nWARNING: ${(bytes / 1024 / 1024).toFixed(2)} MiB is larger than the ${(
      SOFT_LIMIT /
      1024 /
      1024
    ).toFixed(0)} MiB sanity bound.\n` +
      `Check that dist/ holds only frontend assets: node scripts/size-report.mjs`
  );
  process.exit(1);
}
