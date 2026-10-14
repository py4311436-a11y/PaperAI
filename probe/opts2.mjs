import fs from "node:fs";
const s = fs.readFileSync("node_modules/pdfjs-dist/web/pdf_viewer.mjs","utf8");
const v = s.indexOf("class PDFViewer ");
const seg = s.slice(v, v+4000);
const start = seg.indexOf("constructor(");
const body = seg.slice(start, start+4000);
for (const m of body.matchAll(/options\.([a-zA-Z_][\w]*)/g)) console.log("  options."+m[1]);
