import fs from "node:fs";
const s = fs.readFileSync("node_modules/pdfjs-dist/web/pdf_viewer.mjs","utf8");
const v = s.indexOf("class PDFViewer ");
// print constructor region
const seg = s.slice(v, v+2200);
const start = seg.indexOf("constructor(");
console.log(seg.slice(start, start+2000));
