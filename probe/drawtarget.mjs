import fs from "node:fs";
const s = fs.readFileSync(
  "D:/AIreader/PaperAI-PoC/node_modules/pdfjs-dist/build/pdf.mjs",
  "utf8"
);
const i = s.indexOf("class DrawingEditor ");
const seg = s.slice(i, i + 60000);

console.log("=== _getDrawingTarget ===");
const m = /static\s+_getDrawingTarget\s*\([^)]*\)\s*\{/.exec(seg);
let j = seg.indexOf("{", m.index), depth = 0, k = j;
for (; k < seg.length; k++) {
  if (seg[k] === "{") depth++;
  else if (seg[k] === "}") { depth--; if (depth === 0) break; }
}
console.log(seg.slice(m.index, k + 1).replace(/\s+/g, " "));

console.log("\n\n=== _getPointerCoords ===");
const m2 = /static\s+_getPointerCoords\s*\([^)]*\)\s*\{/.exec(seg);
j = seg.indexOf("{", m2.index); depth = 0; k = j;
for (; k < seg.length; k++) {
  if (seg[k] === "{") depth++;
  else if (seg[k] === "}") { depth--; if (depth === 0) break; }
}
console.log(seg.slice(m2.index, k + 1).replace(/\s+/g, " "));

console.log("\n\n=== what DOM does it look for? search for class selectors ===");
for (const mm of seg.matchAll(/closest\("\.[a-zA-Z]+"\)|querySelector\("(\.[a-zA-Z-]+)"\)|getElementsByClassName\("([a-zA-Z-]+)"\)/g)) {
  console.log("  " + mm[0]);
}