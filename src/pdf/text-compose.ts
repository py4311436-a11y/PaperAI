/**
 * Composing readable page text from PDF.js text items.
 *
 * This is deliberately a separate module from the adapter. `getPageText` needs
 * it, but the adapter drags in `pdfjs-dist` and `pdf_viewer.mjs` — module-level
 * side effects and a browser build that Node only supports through the
 * `legacy` entry point. Keeping the composer here means the extraction logic is
 * testable in plain Node, against real fixture output, with no browser and no
 * worker.
 *
 * That separation is not tidiness for its own sake. A-26 (text extraction
 * reading the rendered DOM) reached the user with a green suite precisely
 * because the extraction path was never exercised by any test: every test
 * supplied its own fake `getPageText`, so the code under test was the fake. The
 * thing that was broken had no test that could have seen it.
 */

/** The part of a `getTextContent()` item this needs. Structurally matched. */
export interface TextContentItemLike {
  str?: string;
  hasEOL?: boolean;
}

/**
 * Compose readable page text from `getTextContent()` items.
 *
 * The shape mirrors what the text layer renders, and the parity is deliberate:
 * this replaced an implementation that read the layer's DOM, so the two have to
 * agree or text would change depending on which path produced it.
 *
 * PDF.js emits one item per text-showing operation, appends a `<br>` after the
 * item that ends a line, and positions each item absolutely. So:
 *
 *  - **Line breaks.** `hasEOL` is the signal — the same field its own builder
 *    reads (`build/pdf.mjs`: `hasEOL` -> `document.createElement("br")`). Every
 *    such item ends a line, and an item with no text still ends one: an empty
 *    run followed by a line-ending run is a blank line, which is how a
 *    paragraph gap survives. Runs of blanks collapse to one.
 *
 *  - **Spaces between runs.** The layer's separate `<span>`s read as adjacent
 *    text when concatenated, so a space is needed to stop words merging. But
 *    only between *Latin* runs. Chinese and Japanese have no inter-word spaces,
 *    and inserting one between two CJK characters is visible and wrong — which
 *    is exactly what an unconditional space produces, and why the rule is
 *    script-aware rather than "always add a space".
 *
 * The result is normalised the same way the DOM walk normalised: stray runs of
 * spaces collapse, blank-line runs collapse, and the ends are trimmed.
 */
export function textFromContentItems(items: readonly TextContentItemLike[]): string {
  const lines: string[] = [];
  let line = "";

  const closeLine = () => {
    // Empty lines are kept, not dropped: they are how a paragraph gap is
    // represented. Leading and trailing ones are stripped below.
    lines.push(line.replace(/[ \t]{2,}/g, " ").trim());
    line = "";
  };

  for (const item of items) {
    const str = typeof item.str === "string" ? item.str : "";
    if (str) {
      line += (needsSpace(line, str) ? " " : "") + str;
    }
    if (item.hasEOL) closeLine();
  }
  closeLine();

  while (lines.length && lines[0] === "") lines.shift();
  while (lines.length && lines[lines.length - 1] === "") lines.pop();

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Whether a space belongs between the text already on this line and `next`.
 *
 * Only between two Latin word characters. That covers the case the space exists
 * for — PDF.js splits a line into one item per text-showing operation, so
 * `"Training-"` and `"Parameter"` arrive as separate items and must not become
 * `"Training-Parameter"` — while leaving CJK untouched, where no such gap
 * exists and a space would be an error.
 */
function needsSpace(line: string, next: string): boolean {
  if (!line || line.endsWith(" ")) return false;
  return isLatinWordChar(line[line.length - 1]) && isLatinWordChar(next[0]);
}

function isLatinWordChar(ch: string | undefined): boolean {
  if (!ch) return false;
  return /[0-9A-Za-z]/.test(ch);
}
