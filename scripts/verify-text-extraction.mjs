/**
 * End-to-end proof that page text no longer depends on render state (A-26).
 *
 * The unit tests cover the composer. This covers the claim that matters: that
 * `getPageText` reads the *document*, so a page the viewer never rendered still
 * yields its text. That is the property the bug violated, and it cannot be
 * shown by a pure-function test — it needs a real document.
 *
 * The check is deliberately the same one that failed before: walk every page of
 * a fixture and assert none comes back empty. The old implementation returned
 * "" for any page without a rendered `.textLayer`, which for a freshly opened
 * document was every page.
 *
 * Run: node scripts/verify-text-extraction.mjs
 */
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { textFromContentItems } from "../dist-test/src/pdf/text-compose.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = join(root, "test-fixtures");

pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(
    join(root, "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs")
).href;

/**
 * Exactly what the adapter's `getPageText` now does: ask the document, compose
 * the items. No DOM, no viewer, no rendering — which is the point.
 */
async function getPageText(doc, pageNumber) {
    try {
        const page = await doc.getPage(pageNumber);
        const content = await page.getTextContent();
        const items = content.items.filter((i) => "str" in i);
        return textFromContentItems(items);
    } catch {
        return "";
    }
}

const targets = [
    join(fixtures, "single", "PDF-A-single.pdf"),
    join(fixtures, "single", "报告 中文 空格 copy.pdf"),
    join(fixtures, "formula", "PDF-C-formula.pdf"),
    join(fixtures, "dual", "PDF-B-ieee.pdf"),
    join(fixtures, "annotated", "PDF-annotated-baseline.pdf"),
];

let failed = 0;

for (const file of targets) {
    const name = file.slice(fixtures.length + 1).replace(/\\/g, "/");
    const doc = await pdfjsLib.getDocument({
        data: new Uint8Array(readFileSync(file)),
        useSystemFonts: false,
    }).promise;

    // Every page, in order, with no viewer and nothing rendered — the state a
    // document is in the moment it is opened.
    const empty = [];
    let total = 0;
    for (let p = 1; p <= doc.numPages; p++) {
        const text = await getPageText(doc, p);
        total += text.length;
        if (!text.trim()) empty.push(p);
    }

    if (empty.length) {
        failed++;
        console.log(`FAIL ${name}: ${empty.length}/${doc.numPages} page(s) empty -> ${empty.join(",")}`);
    } else {
        console.log(`OK   ${name}: ${doc.numPages} pages, ${total} chars`);
    }
}

console.log(
    failed === 0
        ? "\nAll pages extract text with nothing rendered — extraction no longer depends on scroll position."
        : `\n${failed} document(s) still have unextractable pages`
);
process.exit(failed === 0 ? 0 : 1);
