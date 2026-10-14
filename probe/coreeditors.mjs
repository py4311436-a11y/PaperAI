import fs from "node:fs";
const s = fs.readFileSync(
  "D:/AIreader/PaperAI-PoC/node_modules/pdfjs-dist/build/pdf.mjs",
  "utf8"
);

console.log("=== editor classes exported from pdf.mjs ===");
const exp = s.slice(s.lastIndexOf("export {"));
const exported = new Set(exp.match(/([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)|,\s*([A-Za-z_$][\w$]*)\s*(?:as\s+([A-Za-z_$][\w$]*))?/g) || []);
const tail = exp.slice(0, 20000);
for (const kw of ["InkEditor", "HighlightEditor", "FreeTextEditor", "AnnotationEditorUIManager",
                  "AnnotationStorage", "AnnotationEditorLayer", "AnnotationEditorParamsType",
                  "AnnotationEditorType", "AnnotationEditorColor"]) {
  const re = new RegExp("\\b" + kw + "\\b");
  console.log(`  ${kw}: ${re.test(tail) ? "EXPORTED" : "not in export list"}`);
}

console.log("\n=== InkEditor constructor signature ===");
for (const kw of ["class InkEditor", "class HighlightEditor"]) {
  const i = s.indexOf(kw);
  if (i === -1) { console.log(`  ${kw}: NOT FOUND`); continue; }
  const chunk = s.slice(i, i + 1800);
  const ctor = chunk.match(/constructor\(([\s\S]{0,400}?)\)\s*\{/);
  console.log(`\n  --- ${kw} ---`);
  console.log("  ctor args: " + (ctor ? ctor[1].replace(/\s+/g, " ") : "?"));
  // public methods
  for (const m of chunk.matchAll(/\n  (?:async )?(#?[a-zA-Z_][\w]*)\s*\(([^)]{0,90})\)\s*\{/g)) {
    console.log(`    ${m[1]}(${m[2].replace(/\s+/g, " ")})`);
  }
}

console.log("\n=== how tools.js creates an InkEditor (core) ===");
for (const m of s.matchAll(/new\s+InkEditor\([\s\S]{0,400}/g)) {
  console.log("  " + m[0].replace(/\s+/g, " ").slice(0, 420));
  break;
}
for (const m of s.matchAll(/new\s+HighlightEditor\([\s\S]{0,300}/g)) {
  console.log("  " + m[0].replace(/\s+/g, " ").slice(0, 320));
  break;
}