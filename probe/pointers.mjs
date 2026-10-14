import fs from "node:fs";
const s = fs.readFileSync(
  "D:/AIreader/PaperAI-PoC/node_modules/pdfjs-dist/build/pdf.mjs",
  "utf8"
);
// DrawingEditor registers a window-level pointerup listener in startDrawing:
//   window.addEventListener("pointerup", e => { if (CurrentPointers.isSamePointerIdOrRemove(e.pointerId)) this._endDraw(e); }, { signal })
// and _endDraw -> endDrawing. Our synthetic pointerup on window should hit it,
// but CurrentPointers uses a private static registry. Inspect it.
const i = s.indexOf("class CurrentPointers");
console.log("=== CurrentPointers ===");
console.log(s.slice(i, i + 2200));