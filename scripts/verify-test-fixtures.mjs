#!/usr/bin/env node
/**
 * Check that the generated test PDFs have the structure the suites rely on.
 *
 * The suites assert on structure, never on content: pages > 0, a non-empty text
 * layer, a Unicode+space path, and (for the two-column fixture) two columns.
 * A generator change that quietly produced a PDF with no text layer would make
 * those assertions fail much later, in a suite that needs a desktop — so it is
 * checked here, headless and in under a second.
 *
 * Also asserts the property that made the fixtures regenerable in the first
 * place: no third-party authorship anywhere in them.
 *
 * Run: node scripts/verify-test-fixtures.mjs
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "test-pdfs");
/**
 * Where pdfjs keeps the metrics for the standard 14 fonts. Without it every
 * load prints "preEvaluateFont failed", and a tool that warns on every run is a
 * tool people stop reading. It has to be a URL with a trailing slash — pdfjs
 * rejects a bare Windows path outright.
 */
const FONT_DATA = pathToFileURL(
  path.join(ROOT, "node_modules", "pdfjs-dist", "standard_fonts") + path.sep
).href;

/** Substrings that must not appear in a fixture's raw bytes. */
const FORBIDDEN = ["IEEE PDFeXpress", "10.1109/", "Transactions on", " Symposium on"];

let failures = 0;
let total = 0;
const check = (ok, label, detail = "") => {
  total++;
  if (!ok) failures++;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
};

async function loadPdfjs() {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // pdfjs wants a worker even in Node. Point it at the file on disk: an empty
  // string, or leaving it unset, fails with "Setting up fake worker failed",
  // which has nothing to do with the PDFs being checked.
  const worker = path.join(ROOT, "node_modules", "pdfjs-dist", "legacy", "build", "pdf.worker.mjs");
  if (!existsSync(worker)) throw new Error(`pdfjs worker not found at ${worker}`);
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(worker).href;
  return pdfjs;
}

async function inspect(pdfjs, file) {
  const data = new Uint8Array(readFileSync(file));
  // getDocument returns a loading task; `destroy()` lives on the task, not on
  // the document it resolves to.
  const task = pdfjs.getDocument({ data, useSystemFonts: true, standardFontDataUrl: FONT_DATA });
  const doc = await task.promise;
  let chars = 0;
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    chars += content.items.reduce((n, item) => n + (item.str?.length ?? 0), 0);
  }
  await task.destroy();
  return { pages: doc.numPages, chars };
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.toLowerCase().endsWith(".pdf")) out.push(full);
  }
  return out;
}

const pdfjs = await loadPdfjs();

if (!existsSync(OUT)) {
  console.error("test-pdfs/ is missing — run: node scripts/make-test-pdfs.mjs");
  process.exit(2);
}

const files = walk(OUT);
check(files.length >= 4, "夹具数量", `${files.length} 个`);

for (const file of files) {
  const rel = path.relative(ROOT, file);
  const bytes = readFileSync(file);
  const { pages, chars } = await inspect(pdfjs, file);
  check(pages > 0, `${rel} 有页面`, `${pages} 页`);
  check(chars > 0, `${rel} 有可提取文字层`, `${chars} 个字符`);
  check(
    bytes.length < 512 * 1024,
    `${rel} 体积合理`,
    `${(bytes.length / 1024).toFixed(1)} KB`
  );
  const raw = bytes.toString("latin1");
  const leaked = FORBIDDEN.filter((needle) => raw.includes(needle));
  check(leaked.length === 0, `${rel} 不含第三方署名`, leaked.join(", "));
}

// The awkward path is the point of one of the fixtures; assert it survived.
const awkward = files.filter((f) => /[^\x20-\x7e]/.test(path.basename(f)));
check(awkward.length >= 1, "存在 Unicode 文件名夹具", awkward.map((f) => path.basename(f)).join(", "));

const bytesTotal = files.reduce((n, f) => n + statSync(f).size, 0);
console.log(`\n${total - failures}/${total} 项检查通过 · 夹具合计 ${(bytesTotal / 1024).toFixed(1)} KB`);
if (failures) {
  console.error(`\n${failures} 项失败 — 重新生成：node scripts/make-test-pdfs.mjs`);
  process.exit(1);
}
