import fs from "node:fs";
const v = fs.readFileSync(
  "D:/AIreader/PaperAI-PoC/node_modules/pdfjs-dist/web/pdf_viewer.mjs",
  "utf8"
);

// The official viewer's toolbar/editor buttons live in pdf_viewer.mjs.
// Look for INK-related handlers.
console.log("=== INK occurrences in viewer (context) ===");
const lines = v.split("\n");
lines.forEach((l, i) => {
  if (/\bINK\b|inkEditor|createInk|InkEditor|ink_editing|inkEditing/.test(l)) {
    console.log(`L${i + 1}: ${l.trim().slice(0, 190)}`);
  }
});

console.log("\n=== 'showannotationeditorui' event consumers ===");
for (const m of v.matchAll(/.{300}showannotationeditorui.{500}/gs)) {
  console.log(m[0].replace(/\s+/g, " ").slice(0, 800));
  console.log("---");
  break;
}

console.log("\n=== editorTypes registration (registerEditorTypes) ===");
const core = fs.readFileSync("D:/AIreader/PaperAI-PoC/node_modules/pdfjs-dist/build/pdf.mjs", "utf8");
const i = core.indexOf("registerEditorTypes(");
console.log(core.slice(i, i + 900));