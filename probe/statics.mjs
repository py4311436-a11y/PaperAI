import fs from "node:fs";
const s = fs.readFileSync(
  "D:/AIreader/PaperAI-PoC/node_modules/pdfjs-dist/build/pdf.mjs",
  "utf8"
);
const li = s.indexOf("class AnnotationEditorLayer");
const chunk = s.slice(li, li + 30000);

console.log("=== AnnotationEditorLayer statics & #editorTypes ===");
const i = chunk.indexOf("static ");
console.log(chunk.slice(i, i + 1800));

console.log("\n\n=== are the editor classes reachable at runtime from pdf.mjs? ===");
// The exported list is the only public surface. Verify what IS exported.
const expStart = s.lastIndexOf("export {");
const exp = s.slice(expStart);
const wanted = ["InkEditor", "HighlightEditor", "FreeTextEditor", "AnnotationEditorLayer",
  "AnnotationEditorUIManager", "AnnotationStorage", "AnnotationEditorType",
  "AnnotationEditorParamsType", "DefaultAnnotationEditorFactory", "AnnotationEditorUIManagerProxy"];
for (const w of wanted) {
  const re = new RegExp("(^|[,{\\s])" + w + "(\\s+as\\s+\\w+)?\\s*[,}]", "m");
  console.log(`  ${w}: ${re.test(exp) ? "EXPORTED" : "NOT exported"}`);
}

console.log("\n=== full export list (editor/storage related) ===");
console.log(exp.replace(/\s+/g, " ").slice(0, 3000));