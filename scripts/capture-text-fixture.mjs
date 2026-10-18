/**
 * Capture real `getTextContent()` output from the fixture PDFs, so the
 * extraction tests can run against actual page data instead of invented shapes.
 *
 * Why this exists: A-26 reached the user with a green suite because every test
 * supplied its own fake `getPageText`, so the adapter's extraction was never
 * exercised. A test whose input is invented by the same person who wrote the
 * code under test only covers the cases they thought of. These fixtures are
 * the cases they did not.
 *
 * Output: test-fixtures/text-items/<name>.page<N>.json
 *
 * Run: node scripts/capture-text-fixture.mjs
 */
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = join(root, "test-fixtures");
const outDir = join(fixtures, "text-items");

pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(
    join(root, "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs")
).href;

/** The fixtures worth capturing: one English paper, one Chinese document. */
const targets = [
    { file: join(fixtures, "single", "PDF-A-single.pdf"), out: "PDF-A-single", pages: 1 },
    { file: join(fixtures, "single", "报告 中文 空格 copy.pdf"), out: "报告-中文-空格", pages: 1 },
    { file: join(fixtures, "formula", "PDF-C-formula.pdf"), out: "PDF-C-formula", pages: 1 },
    { file: join(fixtures, "dual", "PDF-B-ieee.pdf"), out: "PDF-B-ieee", pages: 2 },
];

mkdirSync(outDir, { recursive: true });

for (const t of targets) {
    let doc;
    try {
        doc = await pdfjsLib.getDocument({
            data: new Uint8Array(readFileSync(t.file)),
            useSystemFonts: false,
        }).promise;
    } catch (e) {
        console.log(`SKIP ${t.out}: ${String(e).slice(0, 120)}`);
        continue;
    }

    for (let p = 1; p <= Math.min(t.pages, doc.numPages); p++) {
        const content = await doc.getPage(p).then((pg) => pg.getTextContent());
        const items = content.items
            .filter((i) => "str" in i)
            // Keep only the two fields the composer reads, so a PDF.js type
            // change cannot make a captured fixture stop compiling the tests.
            .map((i) => ({ str: i.str, hasEOL: i.hasEOL }));
        const dest = join(outDir, `${t.out}.page${p}.json`);
        writeFileSync(dest, JSON.stringify(items));
        console.log(`captured ${t.out}.page${p}: ${items.length} items, ${dest.slice(outDir.length + 1)}`);
    }
}

console.log("\ndone — re-run tests/ai-unit via scripts/run-ai-unit-tests.mjs");
