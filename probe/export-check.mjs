// Resolve the Phase-1 contradiction: is AnnotationEditorUIManager exported?
// Checks the LOCKED pdfjs-dist@6.4.299 entry points and the runtime behaviour.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../node_modules/pdfjs-dist/package.json");
console.log("pdfjs-dist version (locked):", pkg.version);
console.log("main:", pkg.main, "| module:", pkg.module, "| types:", pkg.types);
console.log();

const names = [
  "AnnotationEditorUIManager",
  "AnnotationEditorLayer",
  "AnnotationEditorType",
  "AnnotationEditorParamsType",
  "InkEditor",
  "HighlightEditor",
  "AnnotationStorage",
];

function exportList(file) {
  const s = readFileSync(file, "utf8");
  // matches: export { a, b as c };  / export {a};
  const out = new Set();
  for (const m of s.matchAll(/export\s*\{([\s\S]*?)\}\s*;/g)) {
    for (const part of m[1].split(",")) {
      const t = part.trim();
      if (!t) continue;
      const as = t.split(/\s+as\s+/);
      out.add((as[1] ?? as[0]).trim());
    }
  }
  return out;
}

for (const f of ["build/pdf.mjs", "web/pdf_viewer.mjs"]) {
  const path = new URL(`../node_modules/pdfjs-dist/${f}`, import.meta.url);
  let set;
  try {
    set = exportList(path);
  } catch (e) {
    console.log(`--- ${f}: not readable (${e.message})`);
    continue;
  }
  console.log(`--- exports of ${f} (${set.size} total)`);
  for (const n of names) {
    console.log(`      ${n.padEnd(28)} ${set.has(n) ? "EXPORTED" : "not exported"}`);
  }
  console.log();
}

// Runtime confirmation: import the real module and look at the namespace.
const core = await import("pdfjs-dist");
console.log("--- runtime: import('pdfjs-dist') namespace");
for (const n of names) {
  console.log(`      ${n.padEnd(28)} ${core[n] ? "PRESENT (" + typeof core[n] + ")" : "absent"}`);
}
console.log();

const viewer = await import("pdfjs-dist/web/pdf_viewer.mjs");
console.log("--- runtime: import('pdfjs-dist/web/pdf_viewer.mjs') namespace");
for (const n of names) {
  console.log(`      ${n.padEnd(28)} ${viewer[n] ? "PRESENT (" + typeof viewer[n] + ")" : "absent"}`);
}
console.log();

// Can we actually construct it? (constructor arity)
if (core.AnnotationEditorUIManager) {
  console.log("AnnotationEditorUIManager ctor arity:", core.AnnotationEditorUIManager.length);
  console.log("AnnotationEditorUIManager.name      :", core.AnnotationEditorUIManager.name);
}
