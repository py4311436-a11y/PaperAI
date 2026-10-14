import fs from "node:fs";
const s = fs.readFileSync(
  "D:/AIreader/PaperAI-PoC/node_modules/pdfjs-dist/build/pdf.mjs",
  "utf8"
);
const i = s.indexOf("class InkEditor ");
const end = s.indexOf("\nclass ", i + 10);
const seg = s.slice(i, end === -1 ? i + 40000 : end);
console.log("=== InkEditor full class (" + seg.length + " chars) ===");
console.log(seg.slice(0, 6400));