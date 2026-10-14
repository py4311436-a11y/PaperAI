import fs from "node:fs";
const s = fs.readFileSync(
  "D:/AIreader/PaperAI-PoC/node_modules/pdfjs-dist/build/pdf.mjs",
  "utf8"
);
const chunk = s.slice(s.indexOf("class AnnotationEditorUIManager"), s.indexOf("class AnnotationEditorUIManager") + 300000);

for (const name of ["highlightSelection", "getAndRemoveDataFromAnnotationStorage", "addToAnnotationStorage", "getMode", "setEditingState", "addNewEditorFromKeyboard"]) {
  const i = chunk.indexOf("\n  " + name + "(");
  console.log(`\n=== ${name} ===`);
  console.log(i === -1 ? "(not found)" : chunk.slice(i, i + 700));
}

// How does official toolbar create INK? look for the INK editor creation in the
// editor layer, driven by a "mode" and pointer events.
console.log("\n\n=== InkEditor creation inside core (search 'INKEditor' / _editorType 15) ===");
for (const m of s.matchAll(/class InkEditor[\s\S]{0,120}/g)) console.log(m[0].replace(/\s+/g," "));
console.log("\n--- InkEditor static _editorType ---");
const inkI = s.indexOf("class InkEditor");
console.log(s.slice(inkI, inkI + 700).replace(/\s+/g, " "));

console.log("\n=== who calls new InkEditor ===");
let idx = 0, n = 0;
while ((idx = s.indexOf("InkEditor(", idx + 1)) !== -1 && n < 5) {
  n++;
  console.log("  ..." + s.slice(Math.max(0, idx - 200), idx + 160).replace(/\s+/g, " ") + "\n");
}