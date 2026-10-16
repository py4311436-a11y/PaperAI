#!/usr/bin/env node
/**
 * Generate the synthetic test PDFs under `test-pdfs/`.
 *
 * Why these exist: they used to be real IEEE papers. That is fine for a private
 * repository and not fine for a public one — IEEE licences its papers to the
 * individual subscriber, and committing one to a public repository is
 * redistribution the licence does not grant. It also made the repository 13 MB
 * heavier for no testing benefit.
 *
 * So the fixtures are generated here instead, with content written for this
 * purpose. The tests never asserted on the *content* of the old files, only on
 * structure: page count > 0, a non-empty text layer, a Unicode+space path, and
 * (for the two-column one) a two-column layout. This generator reproduces
 * exactly those properties.
 *
 * The PDFs are deliberately written by hand rather than with a library: the
 * output is a few hundred lines of PDF syntax, it needs no new dependency, and
 * every byte that lands in the repository is visible in this file.
 *
 * Run: node scripts/make-test-pdfs.mjs
 */
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "test-pdfs");

/* ------------------------------------------------------------------ text -- */

/**
 * Approximate Helvetica advance widths, good enough for wrapping.
 * Exact metrics are irrelevant here: what matters is that a line does not run
 * off the page and that the words stay separate, so text can be selected.
 */
const CHAR_W = 0.5;
const wrap = (text, fontSize, maxWidth) => {
  const perLine = Math.floor(maxWidth / (fontSize * CHAR_W));
  const lines = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line && (line + " " + word).length > perLine) {
        lines.push(line);
        line = word;
      } else {
        line = line ? line + " " + word : word;
      }
    }
    lines.push(line);
  }
  return lines;
};

/** Escape a string for a PDF literal `(...)` string. */
const pdfString = (s) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
/** Escape for WinAnsi; drop anything outside Latin-1 rather than emit mojibake. */
const latin1 = (s) => s.replace(/[^\x20-\x7e]/g, "-");

/* ------------------------------------------------------------- pdf writer -- */

const A4 = { w: 595, h: 842 };
const MARGIN = 56;

/**
 * Build a PDF from page descriptions.
 *
 * Each page is `{ lines: [{ text, size, bold, gap }], columns?: 1 | 2 }`.
 * Object numbering is fixed and explicit so the xref table can be written with
 * real byte offsets — PDF.js will reject a file whose offsets are wrong.
 */
function buildPdf({ pages, title, producer }) {
  const objects = [];
  const add = (body) => {
    objects.push(body);
    return objects.length; // 1-based object number
  };

  // Object numbers 1 and 2 are reserved for the catalog and the page tree, and
  // are filled in once the pages are known. Reserving them with placeholders
  // matters: pushing the fonts first would hand them numbers 1 and 2, and the
  // later assignment would silently overwrite them — leaving /F1 pointing at the
  // catalog, which still renders pages but extracts no text at all.
  objects.push("", "");
  const catalogNo = 1;
  const pagesNo = 2;
  const fontNo = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const boldFontNo = add(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"
  );

  const pageNos = [];
  for (const page of pages) {
    const content = renderPage(page);
    const streamNo = add(
      `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`
    );
    const pageNo = add(
      `<< /Type /Page /Parent ${pagesNo} 0 R /MediaBox [0 0 ${A4.w} ${A4.h}] ` +
        `/Resources << /Font << /F1 ${fontNo} 0 R /F2 ${boldFontNo} 0 R >> >> ` +
        `/Contents ${streamNo} 0 R >>`
    );
    pageNos.push(pageNo);
  }

  objects[catalogNo - 1] = `<< /Type /Catalog /Pages ${pagesNo} 0 R >>`;
  objects[pagesNo - 1] =
    `<< /Type /Pages /Kids [${pageNos.map((n) => `${n} 0 R`).join(" ")}] /Count ${pageNos.length} >>`;
  const infoNo = add(
    `<< /Title (${pdfString(latin1(title))}) /Producer (${pdfString(producer)}) ` +
      `/Creator (PaperAI synthetic test fixture) >>`
  );

  let out = "%PDF-1.7\n%âãÏÓ\n";
  const offsets = [0];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  out +=
    `trailer\n<< /Size ${objects.length + 1} /Root ${catalogNo} 0 R /Info ${infoNo} 0 R >>\n` +
    `startxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

function renderPage(page) {
  const parts = ["BT"];
  const columns = page.columns ?? 1;
  const colWidth = (A4.w - MARGIN * 2 - (columns - 1) * 24) / columns;
  // Always hand this loop an array of blocks per column, whatever the page's
  // declared column count — otherwise the single-column case ends up iterating
  // the page object itself.
  const perColumn = columns === 1 ? [page.lines] : splitIntoColumns(page);

  for (const [ci, blocks] of perColumn.entries()) {
    const left = MARGIN + ci * (colWidth + 24);
    let y = A4.h - MARGIN;
    for (const block of blocks) {
      const size = block.size ?? 11;
      const font = block.bold ? "/F2" : "/F1";
      const leading = block.leading ?? size * 1.45;
      y -= block.gap ?? 0;
      for (const line of wrap(latin1(block.text), size, colWidth)) {
        if (y < MARGIN) break;
        parts.push(`${font} ${size} Tf 1 0 0 1 ${left.toFixed(2)} ${y.toFixed(2)} Tm`);
        parts.push(`(${pdfString(line)}) Tj`);
        y -= leading;
      }
      if (y < MARGIN) break;
    }
  }
  parts.push("ET");
  return parts.join("\n");
}

/** Halve the blocks so a two-column page carries a plausible column split. */
function splitIntoColumns(page) {
  const midpoint = Math.ceil(page.lines.length / 2);
  return [page.lines.slice(0, midpoint), page.lines.slice(midpoint)];
}

/* ------------------------------------------------------------- fixtures -- */

const LOREM = [
  "This document is a synthetic test fixture generated by PaperAI. It exists so that the test suite has a file to open, select text in, and annotate, without carrying anybody else's copyrighted content in the repository.",
  "Every paragraph here was written for this purpose. Nothing in it is copied from any publication, and no claim in it is meant to be true. The layout properties are what matter: several pages, a real extractable text layer, and words that can be selected with the mouse.",
  "The reader under test is exercised against this file. Selection has to produce a range, highlighting has to turn that range into an annotation that survives a reload, and erasing has to remove exactly the annotation that was clicked rather than the previously selected one.",
];

const FORMULA = [
  "The fixture also carries formula-shaped lines so that selection-based paths have something to select. They are deliberately plain text rather than real mathematics:",
  "J_target = 0.5 * ( RMSE(I_meas, I_model) / I_max )",
  "epsilon_threshold = 1e-3",
  "F(Y) = sqrt( sum_i ( y_i - y_hat_i )^2 / N )",
];

const write = (rel, buf) => {
  const dest = path.join(OUT, rel);
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, buf);
  return dest;
};

function prosePage(heading, paragraphs) {
  return {
    columns: 1,
    lines: [
      { text: heading, size: 16, bold: true, gap: 0, leading: 22 },
      ...paragraphs.map((text) => ({ text, size: 11, gap: 10 })),
    ],
  };
}

function main() {
  rmSync(OUT, { recursive: true, force: true });

  // A: general purpose, three pages, the file most suites open.
  const a = buildPdf({
    title: "PaperAI test fixture A — general purpose",
    producer: "PaperAI scripts/make-test-pdfs.mjs",
    pages: [
      prosePage("PaperAI test fixture A", LOREM),
      prosePage("Second page", [LOREM[1], LOREM[2]]),
      prosePage("Third page", [
        "A third page exists so that page-to-page navigation and the whole-document context mode have more than one page to walk.",
        LOREM[0],
      ]),
    ],
  });
  write("PDF-A.pdf", a);

  // B: two columns, which is what the PDF.js compatibility suite exercises.
  const b = buildPdf({
    title: "PaperAI test fixture B — two column layout",
    producer: "PaperAI scripts/make-test-pdfs.mjs",
    pages: [
      {
        columns: 2,
        lines: [
          { text: "Two-column fixture", size: 14, bold: true, gap: 0, leading: 20 },
          { text: LOREM[0], size: 9 },
          { text: LOREM[1], size: 9, gap: 8 },
          { text: LOREM[2], size: 9, gap: 8 },
          { text: "Left and right columns are separate text runs, so a selection that spans the gutter behaves the way it would on a real paper.", size: 9, gap: 8 },
        ],
      },
      {
        columns: 2,
        lines: [
          { text: "Page two", size: 14, bold: true, gap: 0, leading: 20 },
          { text: LOREM[1], size: 9 },
          { text: LOREM[2], size: 9, gap: 8 },
        ],
      },
    ],
  });
  write("PDF-B.pdf", b);

  // C: formula-shaped text, used where a formula has to be selectable.
  const c = buildPdf({
    title: "PaperAI test fixture C — formula shaped text",
    producer: "PaperAI scripts/make-test-pdfs.mjs",
    pages: [
      prosePage("Formula fixture", [FORMULA[0]]),
      prosePage("More formulas", [...FORMULA.slice(1), LOREM[0]]),
    ],
  });
  write("PDF-C.pdf", c);

  // The Unicode + space path fixture. Only the *name* needs to be awkward; the
  // content can be the same document.
  const uni = path.join(OUT, "IEEE期刊 空格测试");
  mkdirSync(uni, { recursive: true });
  const uniName = "参数提取方法 test.pdf";
  writeFileSync(path.join(uni, uniName), a);
  // A second awkward name without CJK, to cover "space but no unicode".
  writeFileSync(path.join(uni, "IEEE two column 副本.pdf"), b);

  const files = ["PDF-A.pdf", "PDF-B.pdf", "PDF-C.pdf", `IEEE期刊 空格测试/${uniName}`];
  console.log(`Generated ${files.length} synthetic fixtures in test-pdfs/`);
  for (const f of files) {
    const p = path.join(OUT, f);
    console.log(`  ${f.padEnd(42)} ${existsSync(p) ? `${(statSync(p).size / 1024).toFixed(1)} KB` : "MISSING"}`);
  }
  console.log("\nAll content is original to this repository; no third-party material is included.");
}

main();
