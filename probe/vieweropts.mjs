import fs from "node:fs";
const s = fs.readFileSync(
  "D:/AIreader/PaperAI-PoC/node_modules/pdfjs-dist/web/pdf_viewer.mjs",
  "utf8"
);
const v = s.indexOf("class PDFViewer ");
const seg = s.slice(v, v + 5000);
const start = seg.indexOf("constructor(");
const body = seg.slice(start, start + 5000);
const names = new Set();
for (const m of body.matchAll(/options\.([a-zA-Z_][\w]*)/g)) names.add(m[1]);
console.log("=== valid PDFViewer options ===");
console.log([...names].sort().map((n) => "  options." + n).join("\n"));

// also: annotationEditorMode default + how updateMode is reached
console.log("\n=== updateMode / undo / redo / getAnnotationStorage on UIManager ===");
const m2 = /class AnnotationEditorUIManager[\s\S]{0,120000}/.exec(s);
if (m2) {
  for (const m of m2[0].matchAll(/\n  (?:async )?(updateMode|addEditor|undo|redo|getAnnotationStorage|getEditors)\s*\(([^)]{0,180})\)\s*\{/g)) {
    console.log(`  ${m[1]}(${m[2].replace(/\s+/g, " ")})`);
  }
}