import fs from "node:fs";
const s = fs.readFileSync(
  "D:/AIreader/PaperAI-PoC/node_modules/pdfjs-dist/build/pdf.mjs",
  "utf8"
);

for (const cls of ["FreeTextEditor", "InkEditor", "StampEditor", "HighlightEditor", "SignatureEditor"]) {
  const i = s.indexOf(`class ${cls} `);
  const end = s.indexOf("\nclass ", i + 10);
  const seg = s.slice(i, end === -1 ? i + 40000 : end);

  console.log(`\n========== ${cls} (${seg.length} chars) ==========`);

  // static METHODS (may be multi-line, bounded by matching braces)
  for (const name of ["canCreateNewEmptyEditor", "isDrawer", "supportMultipleDrawings",
                      "startDrawing", "endDrawing", "initialize"]) {
    const re = new RegExp("static\\s+" + name + "\\s*\\(");
    const m = re.exec(seg);
    if (!m) { console.log(`  static ${name}: (absent)`); continue; }
    // extract balanced body
    let j = seg.indexOf("{", m.index);
    let depth = 0, k = j;
    for (; k < seg.length; k++) {
      if (seg[k] === "{") depth++;
      else if (seg[k] === "}") { depth--; if (depth === 0) break; }
    }
    console.log(`  static ${name}: ${seg.slice(m.index, k + 1).replace(/\s+/g, " ")}`);
  }
}