// Update Stage D with the read-back evidence, and fix the B3.2 assertion in
// desktop-verify.mjs that was fooled by the same array-like-object issue.
import { readFileSync, writeFileSync } from "node:fs";

// ---- 1. desktop-verify.mjs: B3.2 must use Array.from(), not Array.isArray()
let d = readFileSync("tests/desktop-verify.mjs", "utf8");
const badB32 = d.indexOf('record("B3.2", "Highlight 存在且可解析"');
if (badB32 < 0) {
  console.log("B3.2 not found in desktop-verify.mjs");
  process.exit(1);
}

// Find the full B3.2 statement (up to the terminating ');')
const endB32 = d.indexOf(");", badB32) + 2;
const fixedB32 = [
  'const qpRaw = saved.rep.samples.find((s) => s.subtype === "Highlight");',
  "// PDF.js returns quadPoints as an array-LIKE object, not a real array —",
  "// Array.isArray() is false even when the data is there. Always Array.from().",
  "const qp = qpRaw ? { ...qpRaw, quadPoints: Array.from(qpRaw.quadPoints ?? []) } : null;",
  'record("B3.2", "Highlight 含 QuadPoints 几何", qp && qp.quadPoints.length >= 8 ? "PASS" : "FAIL",',
  '  qp ? `page=${qp.page} quadPoints长度=${qp.quadPoints.length}` : "未找到 Highlight 样本");',
].join("\n");

// Replace the preceding two lines (the old qp/ik lookups) plus the record call
const startOfBlock = d.lastIndexOf("const qp =", badB32);
const endOfBlock = d.indexOf("record(\n    \"B3.3\"", badB32);
if (startOfBlock < 0 || endOfBlock < 0) {
  console.log("could not locate B3.2 block bounds", startOfBlock, endOfBlock);
  process.exit(1);
}
d = d.slice(0, startOfBlock) + fixedB32 + "\n  " + d.slice(endOfBlock);
writeFileSync("tests/desktop-verify.mjs", d);
console.log("desktop-verify.mjs B3.2 fixed");

// ---- 2. Stage D: add the read-back section
let r = readFileSync("reports/STAGE_D_SAVE_COMPATIBILITY.md", "utf8");
const anchor = "### 3d. Acrobat Reader — BLOCKED";
const readback = [
  "### 3d. Read-back of the geometry — PASS (and it retracts K-04)",
  "",
  "`tests/readback-annotations.mjs` loads `output/annotated-desktop.pdf` in plain",
  "Node (no browser, no CDP) and reports what a reader would see. Output archived",
  "at `evidence/stage-d/readback-annotations.txt`:",
  "",
  "```",
  "/Subtype /Highlight  rect=[254.0,463.6,296.9,478.0]  color=[255,240,102]  hasAppearance=true",
  "  quadPoints: 1 quad(s), 8 values",
  "    quad 0: (254.7,464.4)..(296.3,477.1)",
  "      covered text: \"with6.5%junctionless\"",
  "/Subtype /Ink  rect=[173.6,365.2,252.6,393.1]  color=[0,0,0]  hasAppearance=true",
  "  inkLists: 1 stroke(s), 26 points, x 177.1..249.1, y 368.7..389.7",
  "/Subtype /Ink  rect=[176.4,309.4,224.6,331.6]  color=[0,0,0]  hasAppearance=true",
  "  inkLists: 1 stroke(s), 26 points, x 179.9..221.1, y 312.8..328.2",
  "/Subtype /Ink  rect=[171.4,304.2,274.4,346.7]  color=[0,0,0]  hasAppearance=true",
  "  inkLists: 1 stroke(s), 26 points, x 174.9..270.9, y 307.5..343.4",
  "```",
  "",
  "Three things this settles:",
  "",
  "1. **The highlight is on the intended text.** The quad covers `junctionless` in",
  "   the abstract — exactly the word the user's screenshot",
  "   (`evidence/stage-d/user-confirmed-highlight.png`) shows highlighted. The",
  "   independent text extraction and the third-party render agree.",
  "2. **`quadPoints` is fully readable** — 8 values, correct box. This retracts the",
  "   old K-04 (\"PDF.js reports an empty quadPoints\"): the data was always there,",
  "   but `quadPoints` is an array-LIKE object so `Array.isArray()` returns false,",
  "   and the Ink property is `inkLists` (plural). That was our test bug, not a",
  "   library defect. `tests/desktop-verify.mjs` B3.2 had the same flaw and is now",
  "   fixed to use `Array.from()`.",
  "3. **The ink strokes carry real geometry** — 3 strokes × 26 points each, with",
  "   coordinate ranges matching their bounding rects, and every annotation has",
  "   an appearance stream.",
  "",
  "### 3e. Acrobat Reader — BLOCKED",
].join("\n");

if (!r.includes(anchor)) {
  console.log("Stage D anchor not found");
  process.exit(1);
}
r = r.replace(anchor, readback);
writeFileSync("reports/STAGE_D_SAVE_COMPATIBILITY.md", r);
console.log("Stage D updated with read-back evidence");
