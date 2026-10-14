import fs from "node:fs";
const s = fs.readFileSync(
  "D:/AIreader/PaperAI-PoC/node_modules/pdfjs-dist/build/pdf.mjs",
  "utf8"
);

// Enumerate the exact static map construction and each class's static flags.
console.log("=== exact static map construction ===");
const li = s.indexOf("class AnnotationEditorLayer");
const chunk = s.slice(li, li + 2000);
const m = chunk.match(/static #editorTypes = new Map\(\[([\s\S]*?)\]\.map/);
console.log("  classes included:", m ? m[1] : "(not matched)");

console.log("\n=== per-class static flags ===");
for (const cls of ["FreeTextEditor", "InkEditor", "StampEditor", "HighlightEditor", "SignatureEditor"]) {
  const i = s.indexOf(`class ${cls} `);
  if (i === -1) { console.log(`  ${cls}: class not found`); continue; }
  const seg = s.slice(i, i + 9000);
  const flags = {};
  for (const f of ["isDrawer", "supportMultipleDrawings", "canCreateNewEmptyEditor", "_editorType", "_type"]) {
    const mm = seg.match(new RegExp("static\\s+" + f + "\\s*=\\s*([^;\\n]{0,60})"));
    if (mm) flags[f] = mm[1].trim();
  }
  // methods on prototype
  const protoHas = {
    startDrawing: new RegExp("\\n  startDrawing\\(").test(seg),
    endDrawing: new RegExp("\\n  endDrawing\\(").test(seg),
    canCreateNewEmptyEditor: new RegExp("\\n  canCreateNewEmptyEditor\\(").test(seg),
  };
  console.log(`\n  --- ${cls} ---`);
  console.log("    statics:", JSON.stringify(flags));
  console.log("    proto:", JSON.stringify(protoHas));
}

console.log("\n\n=== is there a build-time feature flag that strips Ink/Highlight? ===");
for (const mm of s.matchAll(/(SKIP|ENABLE|DISABLE|UNSUPPORTED)_[A-Z_]*\s*=\s*(?:typeof\s+\w+\s*!==\s*"undefined"\s*\?)?[^;]{0,80}/g)) {
  const t = mm[0].replace(/\s+/g, " ");
  if (/INK|HIGHLIGHT|ANNOTATION_EDITOR|FREETEXT|STAMP/i.test(t)) console.log("  " + t);
}

console.log("\n=== FeatureTest / global flags ===");
for (const mm of s.matchAll(/(?:isNodeJS|isChrome|isFirefox|isNode)\s*&&\s*\[[\s\S]{0,200}AnnotationEditor[\s\S]{0,200}/g)) {
  console.log("  " + mm[0].replace(/\s+/g, " ").slice(0, 400));
}