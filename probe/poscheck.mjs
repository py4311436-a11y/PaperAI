import fs from "node:fs";
const s = fs.readFileSync(
  "D:/AIreader/PaperAI-PoC/node_modules/pdfjs-dist/web/pdf_viewer.mjs",
  "utf8"
);
const v = s.indexOf("class PDFViewer ");
const seg = s.slice(v, v + 5000);
const i = seg.indexOf("must be absolutely positioned");
console.log("=== context around the check ===");
console.log(seg.slice(Math.max(0, i - 700), i + 220));