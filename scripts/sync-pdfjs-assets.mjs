// Copy the pdfjs-dist runtime assets (cMaps + standard fonts) into `public/`
// so Vite serves them from the site root in dev and in the packaged app.
//
// Idempotent: if the destination already holds at least as many files as the
// source, the copy is skipped. A previous naive `rmSync` + `cpSync` was
// interrupted mid-run in this environment and left a partial `public/cmaps`,
// which silently breaks CJK PDFs; counting first avoids repeating that.
import { readdirSync, copyFileSync, mkdirSync, existsSync, statSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "pdfjs-dist");

function countFiles(dir) {
  try {
    return readdirSync(dir).length;
  } catch {
    return -1;
  }
}

const jobs = [
  { from: join(src, "cmaps"), to: join(root, "public", "cmaps") },
  { from: join(src, "standard_fonts"), to: join(root, "public", "standard_fonts") },
];

let copied = 0;
for (const { from, to } of jobs) {
  if (!existsSync(from)) {
    console.error(`  MISSING source: ${from}`);
    process.exit(1);
  }
  const srcCount = countFiles(from);
  const dstCount = countFiles(to);

  if (dstCount >= srcCount && dstCount > 0) {
    console.log(`  up to date: ${to.replace(root, ".")} (${dstCount} files)`);
    continue;
  }

  // Top-up only: never delete the destination first. A bulk rmSync+cpSync was
  // killed mid-run in this environment and left the tree half-populated, so we
  // add whatever is missing and leave existing files alone.
  mkdirSync(to, { recursive: true });

  let ok = 0;
  let failed = 0;
  let skipped = 0;
  for (const name of readdirSync(from)) {
    const s = join(from, name);
    if (!statSync(s).isFile()) continue;
    const d = join(to, name);
    try {
      if (existsSync(d) && statSync(d).size === statSync(s).size) {
        skipped++;
        continue;
      }
      copyFileSync(s, d);
      ok++;
    } catch (e) {
      failed++;
      console.error(`  failed to copy ${name}: ${e.message}`);
    }
  }
  copied++;
  console.log(
    `  synced ${ok} new / ${skipped} already present -> ${to.replace(root, ".")}${failed ? ` (${failed} failed)` : ""}`
  );
  if (failed > 0) {
    console.error("  asset sync incomplete");
    process.exit(1);
  }
}
console.log(`pdfjs-dist assets synced (${copied} director${copied === 1 ? "y" : "ies"} updated)`);
