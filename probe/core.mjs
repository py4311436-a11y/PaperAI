import fs from "node:fs";
const s = fs.readFileSync("D:/AIreader/PaperAI-PoC/node_modules/pdfjs-dist/build/pdf.mjs", "utf8");

// AnnotationEditorType enum definition
const i = s.search(/AnnotationEditorType\s*=\s*Object\.freeze|const AnnotationEditorType/);
console.log("===== AnnotationEditorType definition =====");
console.log(i === -1 ? "(enum def not found inline)" : s.slice(i, i + 700));

// The literal string values used for editor types
console.log("\n===== editor type string literals =====");
for (const m of [...s.matchAll(/"(FREETEXT|INK|HIGHLIGHT|STAMP|SIGNATURE|DISABLE|NONE)"/g)].slice(0, 40)) {
  console.log("  " + m[1]);
}

// AnnotationStorage public methods
console.log("\n===== AnnotationStorage class methods =====");
const ai = s.indexOf("class AnnotationStorage");
if (ai !== -1) {
  const chunk = s.slice(ai, ai + 6000);
  for (const m of chunk.matchAll(/\n  (?:async )?(#?[a-zA-Z_][\w]*)\s*\(([^)]{0,160})\)\s*\{/g)) {
    console.log(`  ${m[1]}(${m[2].replace(/\s+/g, " ")})`);
  }
}

// save-related methods on annotationStorage / document
console.log("\n===== saveDocument + related on PDFDocumentProxy =====");
const di = s.indexOf("class PDFDocumentProxy");
if (di !== -1) {
  const chunk = s.slice(di, di + 40000);
  for (const m of chunk.matchAll(/\n  (?:async )?(#?[a-zA-Z_][\w]*)\s*\(([^)]{0,200})\)\s*\{/g)) {
    if (/save|annotation|Print/i.test(m[1])) console.log(`  ${m[1]}(${m[2].replace(/\s+/g, " ")})`);
  }
}