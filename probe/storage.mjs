import fs from "node:fs";
const s = fs.readFileSync(
  "D:/AIreader/PaperAI-PoC/node_modules/pdfjs-dist/build/pdf.mjs",
  "utf8"
);

// how does pdfViewer pass storage to saveDocument? find "save" handler in viewer
const v = fs.readFileSync(
  "D:/AIreader/PaperAI-PoC/node_modules/pdfjs-dist/web/pdf_viewer.mjs",
  "utf8"
);
console.log("=== save event / saveDocument call sites in viewer ===");
for (const m of v.matchAll(/[\s\S]{0,300}saveDocument\([\s\S]{0,300}/g)) {
  console.log("  ...\n" + m[0].replace(/\s+/g, " ").slice(0, 620) + "\n");
}

console.log("\n=== annotationStorage getter in viewer (any) ===");
for (const m of v.matchAll(/[\s\S]{0,120}annotationStorage[\s\S]{0,200}/g)) {
  const t = m[0].replace(/\s+/g, " ");
  if (/get\s+annotationStorage|\.annotationStorage\b/.test(t)) console.log("  " + t.slice(0, 320));
}

// In core: who sets #annotationStorage on the document?
console.log("\n=== setAnnotationStorage / annotationStorage assignment in core ===");
for (const m of s.matchAll(/[\s\S]{0,160}annotationStorage\s*=\s*[\s\S]{0,120}/g)) {
  console.log("  " + m[0].replace(/\s+/g, " ").slice(0, 300));
}

console.log("\n=== AnnotationStorage.serializable / getSerializable ===");
const ai = s.indexOf("class AnnotationStorage");
console.log(s.slice(ai, ai + 1800));