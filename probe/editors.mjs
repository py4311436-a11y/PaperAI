import fs from "node:fs";
const v = fs.readFileSync(
  "D:/AIreader/PaperAI-PoC/node_modules/pdfjs-dist/web/pdf_viewer.mjs",
  "utf8"
);

// how does UIManager create editors internally? find addEditor( call sites & helpers
console.log("=== addEditor( call sites in pdf_viewer.mjs ===");
for (const m of v.matchAll(/(?:this\.)?#?annotationEditorUIManager\.addEditor\([\s\S]{0,200}/g)) {
  console.log("  " + m[0].replace(/\s+/g, " ").slice(0, 220));
}

console.log("\n=== search for InkEditor / HighlightEditor instantiation ===");
for (const kw of ["InkEditor", "HighlightEditor", "FreeTextEditor", "StampEditor"]) {
  const re = new RegExp("new\\s+" + kw + "\\([\\s\\S]{0,300}", "g");
  const hits = [...v.matchAll(re)];
  console.log(`\n--- ${kw}: ${hits.length} site(s) ---`);
  hits.slice(0, 2).forEach((h) => console.log("   " + h[0].replace(/\s+/g, " ").slice(0, 320)));
}

console.log("\n=== toolbar.js style: get mode / param descriptors ===");
for (const m of v.matchAll(/\n  (?:async )?(#createEditor|_createEditor|createAndAdd|addEditorInternal)\s*\([\s\S]{0,300}/g)) {
  console.log("  " + m[0].replace(/\s+/g, " ").slice(0, 340));
}