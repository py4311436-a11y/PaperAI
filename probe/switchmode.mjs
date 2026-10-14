import fs from "node:fs";
const s = fs.readFileSync(
  "D:/AIreader/PaperAI-PoC/node_modules/pdfjs-dist/build/pdf.mjs",
  "utf8"
);
const ai = s.indexOf("class AnnotationEditorUIManager");
const chunk = s.slice(ai, ai + 300000);

// full public method list (2-space indent, no #)
const pub = new Set();
for (const m of chunk.matchAll(/\n  (?:async )?(?!#)([a-zA-Z_$][\w$]*)\s*\(/g)) pub.add(m[1]);
console.log("=== public-ish methods ===");
console.log([...pub].join(", "));

console.log("\n=== switchToMode signature + body ===");
const i = chunk.indexOf("switchToMode(");
console.log(chunk.slice(i, i + 900));

console.log("\n=== storage getter name ===");
for (const m of chunk.matchAll(/\n  (?:get )?(#?annotationStorage|#?getAnnotationStorage)\s*\(/g)) {
  console.log("  " + m[0].trim());
}
// find where storage is exposed
for (const m of chunk.matchAll(/annotationStorage[\s\S]{0,120}/g)) {
  const t = m[0].replace(/\s+/g, " ");
  if (/get |this\.#annotationStorage =|public/.test(t)) console.log("  > " + t.slice(0, 140));
}

console.log("\n=== how many editors tracked (#allEditors) ===");
const j = chunk.indexOf("#allEditors");
console.log(chunk.slice(j - 200, j + 300).replace(/\s+/g, " "));