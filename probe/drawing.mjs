import fs from "node:fs";
const s = fs.readFileSync(
  "D:/AIreader/PaperAI-PoC/node_modules/pdfjs-dist/build/pdf.mjs",
  "utf8"
);
const i = s.indexOf("class DrawingEditor ");
const end = s.indexOf("\nclass ", i + 10);
const seg = s.slice(i, end === -1 ? i + 60000 : end);
console.log("=== DrawingEditor: static startDrawing / endDrawing / isDrawer ===");
for (const name of ["startDrawing", "endDrawing", "get isDrawer", "isDrawer", "static get"]) {
  const re = new RegExp("static\\s+(?:get\\s+)?" + name.replace("get ", "") + "\\s*\\(");
  const m = re.exec(seg);
  if (!m) continue;
  let j = seg.indexOf("{", m.index);
  let depth = 0, k = j;
  for (; k < seg.length; k++) {
    if (seg[k] === "{") depth++;
    else if (seg[k] === "}") { depth--; if (depth === 0) break; }
  }
  console.log(`\n--- static ${name} ---`);
  console.log(seg.slice(m.index, k + 1).replace(/\s+/g, " "));
}

console.log("\n\n=== DrawingEditor static props (isDrawer etc) ===");
for (const m of seg.matchAll(/static\s+_?[a-zA-Z]+(\s*=\s*[^;\n]{0,50})?/g)) {
  console.log("  " + m[0].replace(/\s+/g, " "));
}