import fs from "node:fs";
const s = fs.readFileSync(
  "D:/AIreader/PaperAI-PoC/node_modules/pdfjs-dist/build/pdf.mjs",
  "utf8"
);
const li = s.indexOf("class AnnotationEditorLayer");
const chunk = s.slice(li, li + 160000);

console.log("=== currentEditorType mentions ===");
for (const m of chunk.matchAll(/.{130}currentEditorType.{130}/gs)) {
  console.log("  ...\n" + m[0].replace(/\s+/g, " ") + "\n");
}

console.log("\n=== createAndAddNewEditor ===");
const i = chunk.indexOf("createAndAddNewEditor(");
console.log(chunk.slice(i, i + 900));

console.log("\n\n=== addNewEditor( signature ===");
const j = chunk.indexOf("\n  addNewEditor(");
console.log(chunk.slice(j, j + 700));