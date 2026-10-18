/**
 * Diagnostic: does a fixture PDF have extractable text at all?
 *
 * This separates the two possible causes of "未能提取到文本":
 *   (a) the document really is image-only, so there is nothing to extract;
 *   (b) the text exists but the app's extraction path does not reach it.
 *
 * (b) is the one that matters, because it is a bug. `getPageText()` reads the
 * *rendered DOM* `.textLayer`, which PDF.js only builds for pages it has
 * actually rendered -- so a page that was never scrolled into view has no text
 * layer and reads as empty. That makes text extraction depend on scroll
 * position, which is not a property a user would expect of "read the document".
 *
 * `getTextContent()` asks the document directly and has no such dependency.
 * If this script finds text where the app finds none, the app's path is the bug.
 *
 * Run: node scripts/diagnose-text-extraction.mjs
 */
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = join(root, "test-fixtures");

pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(
    join(root, "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs")
).href;

function walk(dir, out = []) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (e.name.toLowerCase().endsWith(".pdf")) out.push(p);
    }
    return out;
}

const files = walk(fixtures);
if (!files.length) {
    console.error("no fixture PDFs found under test-fixtures/");
    process.exit(1);
}

console.log(`${files.length} fixture PDF(s)\n`);

for (const file of files) {
    const rel = file.slice(fixtures.length + 1).replace(/\\/g, "/");
    let doc;
    try {
        const data = new Uint8Array(readFileSync(file));
        doc = await pdfjsLib.getDocument({ data, useSystemFonts: false }).promise;
    } catch (e) {
        console.log(`${rel}\n  FAILED TO OPEN: ${String(e).slice(0, 120)}\n`);
        continue;
    }

    let withText = 0;
    let total = 0;
    const empty = [];
    // Cap the walk: this is a diagnostic, not a benchmark.
    const n = Math.min(doc.numPages, 20);
    for (let p = 1; p <= n; p++) {
        let chars = 0;
        try {
            const tc = await doc.getPage(p).then((pg) => pg.getTextContent());
            chars = tc.items
                .map((i) => (typeof i.str === "string" ? i.str : ""))
                .join("")
                .trim().length;
        } catch (e) {
            console.log(`  page ${p}: getTextContent threw ${String(e).slice(0, 100)}`);
        }
        total += chars;
        if (chars > 0) withText++;
        else empty.push(p);
    }

    const verdict =
        total === 0
            ? "IMAGE-ONLY (nothing to extract)"
            : withText === n
                ? "ALL PAGES HAVE TEXT"
                : `MIXED: ${withText}/${n} pages have text, empty: ${empty.join(",")}`;
    console.log(`${rel}`);
    console.log(`  pages=${doc.numPages}  textChars=${total}  -> ${verdict}\n`);
    // No destroy(): the legacy build's document proxy does not expose it, and
    // this is a short-lived diagnostic process anyway.
}
