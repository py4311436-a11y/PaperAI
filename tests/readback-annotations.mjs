/**
 * Independent read-back of the annotated PDF: which text does the Highlight
 * actually cover, and do the Ink strokes carry real geometry?
 *
 * Runs PDF.js in plain Node — no browser, no CDP (currently disabled on this
 * machine, see K-13), no Tauri.
 *
 * IMPORTANT — PDF.js's annotation objects are NOT plain arrays:
 *   - `quadPoints` is an array-LIKE object ({"0":..,"1":..}), so
 *     `Array.isArray()` is FALSE even though the data is present. Use
 *     `Array.from()`.
 *   - the Ink property is `inkLists` (plural), not `inkList`.
 *   - `color` is array-like too, in 0-255 RGB.
 * Getting these names/types wrong looks exactly like "PDF.js lost the data",
 * which is how a bogus K-04 entry got written. It was a test bug, not a
 * library bug.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const FILE = process.argv[2] ?? path.join(ROOT, "output", "annotated-desktop.pdf");

/** Array.from works on both real arrays and PDF.js's array-like objects. */
const arr = (v) => (v == null ? null : Array.from(v));

async function main() {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(readFileSync(FILE));
  const doc = await pdfjs.getDocument({ data }).promise;

  console.log(`file  : ${FILE}`);
  console.log(`pages : ${doc.numPages}\n`);

  let totalHl = 0;
  let totalInk = 0;

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const annots = await page.getAnnotations({ intent: "display" });
    if (!annots.length) continue;

    const items = (await page.getTextContent()).items.filter((i) => typeof i.str === "string" && i.str.trim());

    console.log(`--- page ${p}: ${annots.length} annotation(s) ---`);
    for (const a of annots) {
      const rect = arr(a.rect)?.map((n) => n.toFixed(1)).join(", ");
      const col = arr(a.color)?.map((n) => Math.round(n)).join(",");
      console.log(`  /Subtype /${a.subtype}  rect=[${rect}]  color=[${col}]  hasAppearance=${a.hasAppearance}`);

      if (a.subtype === "Highlight") {
        totalHl++;
        const qp = arr(a.quadPoints);
        if (!qp || !qp.length) {
          console.log("    quadPoints: MISSING");
          continue;
        }
        const nQuads = qp.length / 8;
        console.log(`    quadPoints: ${nQuads} quad(s), ${qp.length} values`);
        for (let q = 0; q < nQuads; q++) {
          const quad = qp.slice(q * 8, q * 8 + 8);
          const xs = [quad[0], quad[2], quad[4], quad[6]];
          const ys = [quad[1], quad[3], quad[5], quad[7]];
          const lo = { x: Math.min(...xs), y: Math.min(...ys) };
          const hi = { x: Math.max(...xs), y: Math.max(...ys) };
          // Text item transform[4],[5] is the origin in PDF user space
          // (y from the bottom), same space as quadPoints.
          const covered = items
            .filter((it) => {
              const ix = it.transform[4], iy = it.transform[5];
              return ix >= lo.x - 3 && ix <= hi.x + 3 && iy >= lo.y - 3 && iy <= hi.y + 3;
            })
            .map((it) => it.str)
            .join("");
          console.log(`      quad ${q}: (${lo.x.toFixed(1)},${lo.y.toFixed(1)})..(${hi.x.toFixed(1)},${hi.y.toFixed(1)})`);
          console.log(`        covered text: ${JSON.stringify(covered)}`);
        }
      }

      if (a.subtype === "Ink") {
        totalInk++;
        const lists = a.inkLists;
        if (!lists || !lists.length) {
          console.log("    inkLists: MISSING");
          continue;
        }
        let pts = 0;
        const all = [];
        for (const s of lists) {
          const sa = arr(s) ?? [];
          pts += sa.length / 2;
          all.push(...sa);
        }
        const xs = all.filter((_, i) => i % 2 === 0);
        const ys = all.filter((_, i) => i % 2 === 1);
        console.log(
          `    inkLists: ${lists.length} stroke(s), ${pts} points, ` +
            `x ${Math.min(...xs).toFixed(1)}..${Math.max(...xs).toFixed(1)}, ` +
            `y ${Math.min(...ys).toFixed(1)}..${Math.max(...ys).toFixed(1)}`
        );
      }
    }
    console.log();
  }

  console.log(`totals: ${totalHl} Highlight, ${totalInk} Ink`);
  await doc.cleanup();
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
