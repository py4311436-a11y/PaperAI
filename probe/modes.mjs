import fs from "node:fs";
const s = fs.readFileSync("D:/AIreader/PaperAI-PoC/node_modules/pdfjs-dist/web/pdf_viewer.mjs", "utf8");

function grepAll(label, re, limit = 25) {
  console.log("\n===== " + label + " =====");
  let n = 0;
  for (const m of s.matchAll(re)) {
    if (n++ >= limit) break;
    console.log("  " + m[0].replace(/\s+/g, " ").slice(0, 220));
  }
  if (n === 0) console.log("  (none)");
}

grepAll("annotationEditorMode option", /annotationEditorMode/g, 12);
grepAll("AnnotationEditorType usages", /AnnotationEditorType\.[A-Z_]+/g, 25);
grepAll("tool names (INK/FREETEXT/HIGHLIGHT)", /\b(?:INK|FREETEXT|HIGHLIGHT|STAMP|SIGNATURE)\b(?=[,"'\]])/g, 20);

// find how to switch active tool
grepAll("updateMode / addEditor-ish methods", /\n  (?:async )?(updateMode|addEditor|switchToEditor|setMode|updateMode)\s*\(/g, 20);

// The eventBus event names related to editors
grepAll("editor events", /dispatch\("(annotationeditor|editingaction|switchannotationeditor)[a-z]*"/g, 25);