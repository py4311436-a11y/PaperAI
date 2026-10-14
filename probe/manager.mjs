import fs from "node:fs";
const SRC = "D:/AIreader/PaperAI-PoC/node_modules/pdfjs-dist/web/pdf_viewer.mjs";
const s = fs.readFileSync(SRC, "utf8");

// Find the enclosing method that dispatches "annotationeditoruimanager"
const dispatchIdx = s.indexOf('eventBus.dispatch("annotationeditoruimanager"');
console.log("dispatch @", dispatchIdx);

// walk backwards to find the method signature
const back = s.slice(Math.max(0, dispatchIdx - 4000), dispatchIdx);
const m = [...back.matchAll(/\n  (?:async )?([#a-zA-Z_][\w]*)\s*\(([^)]*)\)\s*\{/g)];
console.log("\n=== candidate enclosing methods (last 6 before dispatch) ===");
for (const x of m.slice(-6)) {
  console.log(`  ${x[1]}(${x[2].replace(/\s+/g, " ").slice(0, 300)})`);
}

console.log("\n=== method containing dispatch (verbatim) ===");
console.log(back.slice(-1200));

// Public-ish API surface for editor modes
console.log("\n\n=== annotationEditorMode related public methods on PDFViewer ===");
for (const mm of s.matchAll(/\n  (annotationEditor\w+|switchAnnotationEditor\w*|updateAnnotationEditor\w*)\s*\(([^)]*)\)\s*\{/g)) {
  console.log(`  ${mm[1]}(${mm[2].replace(/\s+/g, " ").slice(0, 200)})`);
}