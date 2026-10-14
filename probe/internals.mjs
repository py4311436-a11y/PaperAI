// Probe pdfjs-dist internals: locate AnnotationEditorUIManager creation + access path
import fs from "node:fs";

const SRC = "D:/AIreader/PaperAI-PoC/node_modules/pdfjs-dist/web/pdf_viewer.mjs";
const s = fs.readFileSync(SRC, "utf8");

function show(label, needle, before = 200, after = 900) {
  console.log("\n========== " + label + " ==========");
  let idx = -1, n = 0;
  while ((idx = s.indexOf(needle, idx + 1)) !== -1 && n < 3) {
    n++;
    console.log(`--- occurrence ${n} @ ${idx} ---`);
    console.log(s.slice(Math.max(0, idx - before), idx + after).replace(/\n\s*\n/g, "\n"));
  }
  if (n === 0) console.log("(not found)");
}

show("UIManager instantiation", "new AnnotationEditorUIManager");
show("UIManager import source", "from \"../build/pdf.mjs\"", 0, 0);
show("switchToEditor / editor mode entry", "switchToEditor", 150, 700);
show("addEditor layer", "addEditor(", 200, 500);