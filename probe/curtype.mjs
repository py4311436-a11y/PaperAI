import fs from "node:fs";
const s = fs.readFileSync(
  "D:/AIreader/PaperAI-PoC/node_modules/pdfjs-dist/build/pdf.mjs",
  "utf8"
);
const li = s.indexOf("class AnnotationEditorLayer");
const chunk = s.slice(li, li + 160000);

console.log("=== layer.updateMode ===");
const i = chunk.indexOf("\n  updateMode(");
console.log(chunk.slice(i, i + 1100));

console.log("\n\n=== #currentEditorType assignment sites ===");
for (const m of chunk.matchAll(/#currentEditorType\s*=\s*[^;]{0,120}/g)) {
  console.log("  " + m[0].replace(/\s+/g, " "));
}

console.log("\n=== what is an 'editorType'? look at the static shape ===");
const st = s.indexOf("static _editorType");
console.log(s.slice(st - 400, st + 500).replace(/\s+/g, " "));

console.log("\n\n=== editorTypes registration source (who builds the array) ===");
for (const m of s.matchAll(/registerEditorTypes\(\[[\s\S]{0,600}/g)) {
  console.log(m[0].replace(/\s+/g, " ").slice(0, 700));
}
for (const m of s.matchAll(/\[\s*FreeTextEditor[\s\S]{0,400}/g)) {
  console.log("ARRAY: " + m[0].replace(/\s+/g, " ").slice(0, 500));
  break;
}