import fs from "node:fs";
const s = fs.readFileSync("node_modules/pdfjs-dist/web/pdf_viewer.mjs","utf8");
const i = s.indexOf("class PDFLinkService");
console.log("=== PDFLinkService methods ===");
const chunk = s.slice(i, i+4000);
for (const m of chunk.matchAll(/\n  (?:async )?([#a-zA-Z_][\w]*)\s*\(([^)]{0,150})\)\s*\{/g))
  console.log(`  ${m[1]}(${m[2].replace(/\s+/g," ")})`);
console.log("\n=== PDFViewer constructor options (verbatim) ===");
const v = s.indexOf("class PDFViewer");
const vchunk = s.slice(v, v+2600);
const ctor = vchunk.match(/constructor\(\{([\s\S]*?)\n  \}/);
console.log(ctor ? ctor[1].slice(0,2400) : "(not matched)");
