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
