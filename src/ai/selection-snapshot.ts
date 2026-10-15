/**
 * PDF text-layer selection capture.
 *
 * THE trap this module exists to avoid: if you read `window.getSelection()`
 * *after* the floating action bar takes focus, the selection is already gone
 * and you send an empty prompt. The bar's buttons therefore must not steal
 * focus, and the snapshot must be taken at `pointerup` / `selectionchange`
 * time — captured before any UI reacts.
 *
 * Equally important: only text from the PDF text layer counts. A user
 * selecting a sentence in the chat panel or the settings dialog must not be
 * mistaken for paper text and uploaded.
 */

import type { SelectionSnapshot } from "./types";

// Re-exported so consumers only need this module for selection handling.
export type { SelectionSnapshot };

/** Elements whose selections are never treated as paper text. */
const NON_PDF_REGIONS = [
  "#ai-panel",
  "#ai-settings",
  "#dirty-modal",
  "#toast",
  "#toolbar",
  "#selection-bar",
];

export function isInsideNonPdfRegion(node: Node | null): boolean {
  let el: Node | null = node;
  while (el) {
    if (el.nodeType === 1) {
      const e = el as Element;
      if (NON_PDF_REGIONS.some((sel) => e.matches?.(sel))) return true;
      if (e.classList?.contains("pdfViewer")) return false;
    }
    el = el.parentNode;
  }
  return false;
}

/** The page number (1-based) a text-layer node belongs to, if any. */
export function pageNumberOf(node: Node | null): number | null {
  let el: Node | null = node;
  while (el) {
    if (el.nodeType === 1) {
      const e = el as Element;
      const attr = e.getAttribute?.("data-page-number");
      if (attr) {
        const n = Number(attr);
        if (Number.isFinite(n) && n > 0) return n;
      }
    }
    el = el.parentNode;
  }
  return null;
}

/** True when the selection is inside a real PDF text layer. */
function isPdfSelection(sel: Selection): boolean {
  if (sel.rangeCount === 0) return false;
  const range = sel.getRangeAt(0);
  const common = range.commonAncestorContainer;

  // A selection with no PDF text in it is not paper text.
  const startPage = pageNumberOf(range.startContainer);
  const endPage = pageNumberOf(range.endContainer);
  if (startPage === null && endPage === null) return false;

  if (isInsideNonPdfRegion(common)) return false;
  // If mixed, require the actual text nodes to be in the viewer.
  return !isInsideNonPdfRegion(range.startContainer) && !isInsideNonPdfRegion(range.endContainer);
}

/**
 * Normalise PDF.js text-layer output.
 *
 * The text layer inserts newlines per visual line and sometimes soft hyphens.
 * We keep the line breaks (they carry meaning for a paragraph) but collapse
 * runs of spaces and drop the zero-width artefacts the layer emits.
 */
export function normalisePdfText(raw: string): string {
  return raw
    .replace(/\u00ad/g, "")          // soft hyphen
    .replace(/[\u200b\u200c\u200d]/g, "") // zero-width joiners/space
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface CaptureOptions {
  /** Identifies the current document; selections from another doc are invalid. */
  documentId: string;
  /** Selection to snapshot. Defaults to `window.getSelection()`. */
  selection?: Selection | null;
  now?: () => number;
}

/**
 * Build a snapshot, or `null` when there is no usable PDF selection.
 *
 * Returning `null` (rather than an empty snapshot) is deliberate: callers must
 * not silently fall back to "send the whole document".
 */
export function captureSelection(opts: CaptureOptions): SelectionSnapshot | null {
  const sel = opts.selection ?? window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  if (!isPdfSelection(sel)) return null;

  const text = normalisePdfText(sel.toString());
  if (!text) return null;

  const pages = new Set<number>();
  for (let i = 0; i < sel.rangeCount; i++) {
    const r = sel.getRangeAt(i);
    const a = pageNumberOf(r.startContainer);
    const b = pageNumberOf(r.endContainer);
    if (a !== null) pages.add(a);
    if (b !== null) pages.add(b);
  }

  return {
    documentId: opts.documentId,
    pageNumbers: [...pages].sort((a, b) => a - b),
    text,
    capturedAt: (opts.now ?? Date.now)(),
    source: "pdf-text-layer",
  };
}

/** A snapshot is only valid while its document is still open. */
export function isSnapshotCurrent(
  snap: SelectionSnapshot | null,
  currentDocumentId: string | null
): boolean {
  if (!snap) return false;
  return snap.documentId === currentDocumentId;
}

/**
 * Wire the capture points.
 *
 * `pointerdown` on the floating bar is prevented from taking focus, so the
 * selection survives a click on `Explain` / `Translate`. `selectionchange` and
 * `pointerup` update the live snapshot. Returns a disposer.
 */
export function installSelectionTracking(
  viewer: HTMLElement,
  getDocumentId: () => string | null,
  onSnapshot: (snap: SelectionSnapshot | null) => void,
  doc: Document = document
): () => void {
  let raf = 0;
  const schedule = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const id = getDocumentId();
      if (!id) return onSnapshot(null);
      onSnapshot(captureSelection({ documentId: id }));
    });
  };

  const onSelectionChange = () => schedule();
  const onPointerUp = () => schedule();
  const onKeyUp = () => schedule();
  // A click that collapses the selection must clear the bar.
  const onPointerDown = (e: Event) => {
    const t = e.target as Node | null;
    if (!t || isInsideNonPdfRegion(t)) {
      onSnapshot(null);
    }
  };

  doc.addEventListener("selectionchange", onSelectionChange);
  viewer.addEventListener("pointerup", onPointerUp, true);
  viewer.addEventListener("keyup", onKeyUp, true);
  doc.addEventListener("pointerdown", onPointerDown, true);

  return () => {
    if (raf) cancelAnimationFrame(raf);
    doc.removeEventListener("selectionchange", onSelectionChange);
    viewer.removeEventListener("pointerup", onPointerUp, true);
    viewer.removeEventListener("keyup", onKeyUp, true);
    doc.removeEventListener("pointerdown", onPointerDown, true);
  };
}

/**
 * Prevent a floating-bar control from stealing the selection.
 * Attach to `pointerdown`; the click still fires normally.
 */
export function keepSelectionAlive(el: HTMLElement): void {
  el.addEventListener("pointerdown", (e) => e.preventDefault());
  el.addEventListener("mousedown", (e) => e.preventDefault());
}
