// Copy the pdfjs-dist runtime assets (cMaps + standard fonts) into `public/`
// so that Vite serves them at the site root in both dev and production.
// Must run before `vite build` and `tauri build`.
import { cpSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "pdfjs-dist");

const jobs = [
  { from: join(src, "cmaps"), to: join(root, "public", "cmaps") },
  { from: join(src, "standard_fonts"), to: join(root, "public", "standard_fonts") },
];

for (const { from, to } of jobs) {
  if (!existsSync(from)) {
    console.error(`  MISSING source: ${from}`);
    process.exit(1);
  }
  rmSync(to, { recursive: true, force: true });
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
  console.log(`  copied ${from.replace(root, ".")} -> ${to.replace(root, ".")}`);
}
console.log("pdfjs-dist assets synced");
