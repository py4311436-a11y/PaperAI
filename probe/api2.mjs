import fs from "node:fs";
const s = fs.readFileSync(
  "D:/AIreader/PaperAI-PoC/node_modules/pdfjs-dist/build/pdf.mjs",
  "utf8"
);

// 1) zoom / setScale valid values in PDFViewer
console.log("=== PDFViewer #setScale unknown-zoom check (viewer) ===");
const v = fs.readFileSync(
  "D:/AIreader/PaperAI-PoC/node_modules/pdfjs-dist/web/pdf_viewer.mjs",
  "utf8"
);
for (const m of v.matchAll(/#setScale\([^)]*\)\s*\{[\s\S]{0,400}?unknown zoom[\s\S]{0,120}/g)) {
  console.log(m[0].slice(0, 560));
  break;
}

// list valid scale names
console.log("\n=== valid currentScaleValue candidates ===");
const names = new Set();
for (const m of v.matchAll(/case\s+"([a-zA-Z_-]+)":/g)) names.add(m[1]);
console.log([...names].join(", "));

// 2) UIManager addEditor signature in pdf.mjs
console.log("\n=== AnnotationEditorUIManager.addEditor ===");
const ai = s.indexOf("class AnnotationEditorUIManager");
if (ai !== -1) {
  const chunk = s.slice(ai, ai + 200000);
  for (const m of chunk.matchAll(/\n  (?:async )?(updateMode|addEditor|undo|redo|getAnnotationStorage|getEditors)\s*\(([^)]{0,200})\)\s*\{/g)) {
    console.log(`  ${m[1]}(${m[2].replace(/\s+/g, " ")})`);
  }
}

// 3) AnnotationEditorLayer addEditor
console.log("\n=== AnnotationEditorLayer.addEditor ===");
const li = s.indexOf("class AnnotationEditorLayer");
if (li !== -1) {
  const chunk = s.slice(li, li + 120000);
  for (const m of chunk.matchAll(/\n  (?:async )?(addEditor|addEditors|enable|update)\s*\(([^)]{0,200})\)\s*\{/g)) {
    console.log(`  ${m[1]}(${m[2].replace(/\s+/g, " ")})`);
  }
}

// 4) how official viewer creates an INK editor
console.log("\n=== official INK creation pattern (search) ===");
for (const m of v.matchAll(/addEditor\([^)]{0,160}\)/g)) console.log("  " + m[0].replace(/\s+/g," "));
for (const m of v.matchAll(/addEditors?\.[a-zA-Z]+/g)) console.log("  " + m[0]);