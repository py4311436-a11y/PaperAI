/**
 * The text of a page that falls inside a rectangle.
 *
 * The point of this module: a reader who selects a region of a page and asks
 * for it to be translated does not need the *image* of that region, they need
 * the *text* in it — and the text layer already has it, exactly, with no OCR and
 * no guessing. A scanned page has no text layer, and there the image is the
 * only source; that is the caller's problem, not this module's.
 *
 * All coordinates are in PDF user space: the origin is at the bottom left, x
 * grows right and y grows **up**. The canvas the reader selected on has the
 * origin at the top left with y growing down, so the caller converts.
 *
 * Pure, and therefore testable without a PDF: the geometry is the whole of the
 * risk here, and a bug in it would silently return the wrong paragraph.
 */

/** The part of a `getTextContent()` item this needs. Structurally matched. */
export interface TextItemWithGeometry {
  str?: string;
  hasEOL?: boolean;
  /** PDF.js text matrix: [a, b, c, d, e, f]; `e`/`f` are the position. */
  transform?: number[];
  /** Advance width in user space. */
  width?: number;
  /** Font height in user space. */
  height?: number;
}

/** A rectangle in PDF user space, origin bottom left, y up. */
export interface UserSpaceRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The box an item occupies, in user space.
 *
 * `transform[5]` is the *baseline*, so the glyphs sit above it. Using the
 * baseline as the bottom edge would put every line half a line too low and
 * shift the selection up by one line — which is the kind of error that looks
 * like the text was right but was the previous paragraph.
 */
export function itemBox(item: TextItemWithGeometry): {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
} | null {
  const t = item.transform;
  if (!t || t.length < 6) return null;
  const x = t[4];
  const baseline = t[5];
  const w = typeof item.width === "number" ? item.width : 0;
  const h = typeof item.height === "number" ? item.height : 0;
  if (!Number.isFinite(x) || !Number.isFinite(baseline)) return null;
  return { x0: x, y0: baseline, x1: x + w, y1: baseline + h };
}

/**
 * Whether an item's box overlaps the region.
 *
 * Overlap, not containment: a line whose baseline is just outside the region
 * still has glyphs inside it, and a reader who dragged across a paragraph
 * means that paragraph. Requiring full containment would drop the first and
 * last lines of every selection.
 */
export function itemOverlaps(
  item: TextItemWithGeometry,
  region: UserSpaceRect
): boolean {
  const box = itemBox(item);
  if (!box) return false;
  const rx1 = region.x + region.width;
  const ry1 = region.y + region.height;
  // A zero-height region still selects the text sitting on it.
  const vertical = box.y0 <= ry1 && box.y1 >= region.y;
  const horizontal = box.x0 <= rx1 && box.x1 >= region.x;
  return vertical && horizontal;
}

/**
 * The text of the items inside a region, in reading order.
 *
 * Order is the order PDF.js emitted them, which is the content stream order —
 * for a two-column paper that is column by column, and a selection that spans
 * a column boundary therefore reads down the first column and then the second.
 * That matches what the reader sees on the page, which is the right answer for
 * a selection.
 */
export function textInRegion(
  items: readonly TextItemWithGeometry[],
  region: UserSpaceRect
): string {
  const selected = items.filter((i) => itemOverlaps(i, region));
  return composeText(selected);
}

/**
 * Join selected items into readable text.
 *
 * The same rules the page composer uses, applied to a subset: a line break
 * where the item says there is one, and a space between two Latin runs so
 * words do not merge. Chinese has no inter-word spaces, so the space is only
 * added between Latin characters.
 */
function composeText(items: readonly TextItemWithGeometry[]): string {
  let out = "";
  let lastWasLatin = false;

  for (const item of items) {
    const str = item.str ?? "";
    if (str) {
      const isLatin = isLatinRun(str);
      if (out && lastWasLatin && isLatin) out += " ";
      out += str;
      lastWasLatin = isLatin;
    }
    if (item.hasEOL) {
      out += "\n";
      lastWasLatin = false;
    }
  }
  return out
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** True when a run is Latin script, i.e. words need a space between them. */
function isLatinRun(s: string): boolean {
  const first = s.trim()[0];
  if (!first) return false;
  const code = first.codePointAt(0)!;
  // Latin, Greek and Cyrillic are spaced scripts; CJK and Arabic are not.
  return (
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x00c0 && code <= 0x024f) ||
    (code >= 0x0370 && code <= 0x04ff) ||
    (code >= 0x0400 && code <= 0x04ff)
  );
}
