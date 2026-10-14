import fs from "node:fs";
const s = fs.readFileSync(
  "D:/AIreader/PaperAI-PoC/node_modules/pdfjs-dist/build/pdf.mjs",
  "utf8"
);

// AnnotationEditorLayer: how does it start a new editor on pointerdown?
const li = s.indexOf("class AnnotationEditorLayer");
const chunk = s.slice(li, li + 160000);

console.log("=== AnnotationEditorLayer public methods ===");
const pub = new Set();
for (const m of chunk.matchAll(/\n  (?:async )?(?!#)([a-zA-Z_$][\w$]*)\s*\(/g)) pub.add(m[1]);
console.log([...pub].join(", "));

console.log("\n=== pointerdown handler in layer ===");
const pi = chunk.indexOf("pointerdown(");
console.log(chunk.slice(pi, pi + 1500));

console.log("\n=== addEditor( body in layer ===");
const ai = chunk.indexOf("\n  addEditor(");
console.log(chunk.slice(ai, ai + 1400));