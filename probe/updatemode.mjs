import fs from "node:fs";
const s = fs.readFileSync(
  "D:/AIreader/PaperAI-PoC/node_modules/pdfjs-dist/build/pdf.mjs",
  "utf8"
);

// AnnotationEditorUIManager.updateMode — full body
const ai = s.indexOf("class AnnotationEditorUIManager");
const chunk = s.slice(ai, ai + 260000);
const i = chunk.indexOf("updateMode(");
console.log("=== updateMode body ===");
console.log(chunk.slice(i, i + 2600));