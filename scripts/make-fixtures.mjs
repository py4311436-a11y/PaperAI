// Build `test-fixtures/` — writable COPIES used by every destructive test.
// Originals (test-pdfs/, the user's library) are never modified.
import { copyFileSync, existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = join(root, "test-fixtures");

rmSync(fixtures, { recursive: true, force: true });
mkdirSync(fixtures, { recursive: true });

const manifest = [];

function add(srcRel, dstRel) {
  const src = join(root, srcRel);
  const dst = join(fixtures, dstRel);
  if (!existsSync(src)) {
    console.log(`  SKIP (missing) ${srcRel}`);
    return;
  }
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  const sha = createHash("sha256").update(readFileSync(dst)).digest("hex");
  manifest.push({ file: dstRel, src: srcRel, bytes: readFileSync(dst).length, sha256: sha });
}

// --- single column / general -------------------------------------------------
add("test-pdfs/PDF-A.pdf", "single/PDF-A-single.pdf");
add("test-pdfs/PDF-A.pdf", "single/报告 中文 空格 copy.pdf"); // Unicode + space path

// --- IEEE two-column ---------------------------------------------------------
add("test-pdfs/PDF-B.pdf", "dual/PDF-B-ieee.pdf");
add("test-pdfs/PDF-B.pdf", "dual/IEEE 双栏 论文 副本.pdf");

// --- formulas / captions -----------------------------------------------------
add("test-pdfs/PDF-C.pdf", "formula/PDF-C-formula.pdf");

// --- already annotated (third-party highlight present) -----------------------
add("output/example_annotated.pdf", "annotated/PDF-annotated-baseline.pdf");

writeFileSync(
  join(fixtures, "MANIFEST.json"),
  JSON.stringify({ generated: new Date().toISOString(), files: manifest }, null, 2)
);

console.log("\nManifest (SHA-256 of each pristine copy):");
for (const m of manifest) console.log(`  ${m.sha256.slice(0, 16)}…  ${m.file}`);
console.log(`\n${manifest.length} fixture(s) -> ${fixtures}`);
