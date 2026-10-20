/**
 * Keeping a text selection across a mode change.
 *
 * PDF.js's highlight conversion reads the *current* DOM selection. Switching
 * the annotation mode can take that selection with it — leaving highlight mode
 * tears down the text layer's pointer handling — and then the conversion finds
 * nothing and does nothing, silently.
 *
 * So the selection is captured before the change and put back afterwards. A
 * `Range` stays valid across a mode change as long as the text nodes it
 * refers to are not replaced, which is the case here: the mode change alters
 * classes and listeners, not the text.
 *
 * Separate from the adapter on purpose: this is the only part of the highlight
 * flow that can be reasoned about without a PDF, and it is the part that fails
 * silently when it is wrong.
 */

/** A selection that can be put back. */
export interface KeptSelection {
  range: Range;
  text: string;
}

/**
 * Capture the current selection, or null if there is nothing to capture.
 *
 * A collapsed selection is not worth keeping: there is nothing to restore, and
 * restoring it would move the caret for no reason.
 */
export function captureSelection(doc: Document = document): KeptSelection | null {
  const sel = doc.getSelection?.();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!range) return null;
  return { range, text: sel.toString() };
}

/**
 * Put a captured selection back.
 *
 * Best effort: if the nodes the range referred to are gone there is nothing
 * to restore, and failing loudly would be worse than leaving the selection
 * where it is.
 */
export function restoreSelection(kept: KeptSelection | null, doc: Document = document): boolean {
  if (!kept) return false;
  const sel = doc.getSelection?.();
  if (!sel) return false;
  try {
    sel.removeAllRanges();
    sel.addRange(kept.range);
    return true;
  } catch {
    return false;
  }
}
