/**
 * PaperAI — PDF.js integration adapter.
 *
 * Purpose (Phase 2 requirement B5): every version-fragile PDF.js call lives
 * here and ONLY here. The UI layer never touches the editor manager, never
 * calls `updateMode` / `highlightSelection` / `endDrawingSession` directly,
 * and never constructs editor classes.
 *
 * All values below were verified against the LOCKED baseline
 * `pdfjs-dist@6.4.299` (see reports/PDFJS_COMPATIBILITY.md). Do not change
 * them without re-running tests/final-verify.mjs.
 */
import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";

import { textFromContentItems } from "./text-compose";
import { textInRegion } from "./text-region";
import { captureSelection, restoreSelection } from "./selection-keep";
import { clampZoom, isZoomGesture, zoomFactorFor } from "./wheel-zoom";

export const PDFJS_VERSION: string = (pdfjsLib as unknown as { version: string }).version;

/* -------------------------------------------------------------------------- */
/* Locked constants                                                            */
/* -------------------------------------------------------------------------- */

/** AnnotationEditorType values, read out of build/pdf.mjs @ 6.4.299. */
export const AnnotationEditorType = {
  DISABLE: -1,
  NONE: 0,
  FREETEXT: 3,
  HIGHLIGHT: 9,
  STAMP: 13,
  INK: 15,
  SIGNATURE: 101,
} as const;

/**
 * Zoom names accepted by `PDFViewer.currentScaleValue` in 6.x.
 * NOTE: the legacy names "width" / "page" were REMOVED in v6 and throw
 * "unknown zoom value" — do not reintroduce them.
 */
export const ZoomMode = {
  ACTUAL: "page-actual",
  WIDTH: "page-width",
  HEIGHT: "page-height",
  FIT: "page-fit",
  AUTO: "auto",
} as const;

export type ToolMode = "select" | "highlight" | "ink";

/* -------------------------------------------------------------------------- */
/* Module-level PDF.js bootstrap                                               */
/* -------------------------------------------------------------------------- */

// `pdf_viewer.mjs` destructures AbortException / DOMException / ... off
// `globalThis.pdfjsLib` at module-evaluation time. It therefore MUST be
// assigned before the dynamic import below. (Verified failure mode in PoC:
// "Cannot read properties of undefined" at load.)
(globalThis as unknown as { pdfjsLib: unknown }).pdfjsLib = pdfjsLib;

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.mjs",
  import.meta.url
).toString();

type PdfViewerModule = typeof import("pdfjs-dist/web/pdf_viewer.mjs");
let viewerModule: PdfViewerModule | null = null;

async function getViewerModule(): Promise<PdfViewerModule> {
  if (!viewerModule) viewerModule = await import("pdfjs-dist/web/pdf_viewer.mjs");
  return viewerModule;
}

/* -------------------------------------------------------------------------- */
/* Diagnostics                                                                 */
/* -------------------------------------------------------------------------- */

export type LogLevel = "info" | "warn" | "error" | "success";

export interface LogEntry {
  t: number;
  level: LogLevel;
  msg: string;
}

export class Diagnostics {
  private readonly entries: LogEntry[] = [];
  private listeners = new Set<(e: LogEntry) => void>();

  log(level: LogLevel, msg: string): void {
    const entry: LogEntry = { t: Date.now(), level, msg };
    this.entries.push(entry);
    if (this.entries.length > 2000) this.entries.shift();
    for (const l of this.listeners) l(entry);
  }

  on(fn: (e: LogEntry) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get all(): readonly LogEntry[] {
    return this.entries;
  }

  errors(): LogEntry[] {
    return this.entries.filter((e) => e.level === "error" || e.level === "warn");
  }
}

/* -------------------------------------------------------------------------- */
/* Adapter                                                                     */
/* -------------------------------------------------------------------------- */

export interface AdapterOptions {
  /** OUTER scrolling element. PDFViewer 6.x requires `position: absolute`. */
  container: HTMLDivElement;
  /** INNER element that receives the `.page` children. */
  viewer: HTMLDivElement;
  diagnostics?: Diagnostics;
}

export interface AnnotationSample {
  page: number;
  subtype: string;
  rect: number[] | null;
  quadPoints: number[] | null;
  inkStrokes: number | null;
  color: unknown;
}

export interface VerifyReport {
  numPages: number;
  countsBySubtype: Record<string, number>;
  samples: AnnotationSample[];
  hasHighlight: boolean;
  hasInk: boolean;
  error?: string;
}

/**
 * Thin, version-pinned wrapper around PDFViewer + AnnotationEditorUIManager.
 *
 * Lifecycle guarantees the UI layer can rely on:
 *  - `open()` resolves once the editor subsystem is available.
 *  - `setTool()` never leaves a half-open ink session behind.
 *  - `serialize()` ALWAYS flushes pending ink first (otherwise strokes drawn
 *    in the current session are silently lost — see KNOWN_ISSUES P1-2).
 */
export class PdfjsAdapter {
  readonly diagnostics: Diagnostics;

  private container: HTMLDivElement;
  private viewerEl: HTMLDivElement;
  private eventBus!: InstanceType<PdfViewerModule["EventBus"]>;
  private linkService!: InstanceType<PdfViewerModule["PDFLinkService"]>;
  private pdfViewer!: InstanceType<PdfViewerModule["PDFViewer"]>;

  private doc: PDFDocumentProxy | null = null;
  /**
   * Extracted text per page, so a reading session does not re-fetch it.
   *
   * `whole-document` mode walks every page on every question, and
   * `getTextContent()` is a worker round-trip each time. Cleared when a
   * document is closed, so the cache can never outlive the document it came
   * from.
   */
  private pageText = new Map<number, string>();
  /** Whether the wheel-zoom listener is already attached (see `wireWheelZoom`). */
  private wheelZoomWired = false;
  /** AnnotationEditorUIManager — captured via EventBus, NOT exported by the lib. */
  private uiManager: any = null;
  private tool: ToolMode = "select";
  private dirtyFlag = false;

  /** Fired whenever the dirty state changes so the shell can update the UI. */
  onDirtyChange: ((dirty: boolean) => void) | null = null;

  private markDirty(v: boolean) {
    if (this.dirtyFlag === v) return;
    this.dirtyFlag = v;
    this.onDirtyChange?.(v);
  }

  /** Name of the currently open document (for UI only). */
  documentName = "";
  /** Path/URL the document came from (never used to write back). */
  documentSource = "";

  constructor(opts: AdapterOptions) {
    this.container = opts.container;
    this.viewerEl = opts.viewer;
    this.diagnostics = opts.diagnostics ?? new Diagnostics();
  }

  /**
   * Wire the Ctrl+wheel zoom gesture.
   *
   * Called from `init()` after the viewer exists, and kept separate so the
   * listener is attached exactly once — `init()` can be awaited more than once
   * by a caller that does not know the viewer is already up.
   *
   * The listener goes on the scroll container because that is the element the
   * cursor is over when the user wants to zoom a page: wheel events on the page
   * bubble through it. Attaching it to `window` instead would also zoom when
   * the pointer is over the AI panel or the toolbar, which is not what the
   * gesture means.
   */
  private wireWheelZoom(): void {
    if (this.wheelZoomWired) return;
    this.wheelZoomWired = true;

    this.container.addEventListener("wheel", (e: WheelEvent) => {
      if (!isZoomGesture(e)) return;

      // The default action for Ctrl+wheel in a WebView is to zoom the whole
      // interface, which is not this app's model — there is one zoom, the
      // document's, and it lives in the toolbar. Prevent it, and only it: a
      // plain wheel must still scroll.
      e.preventDefault();

      const factor = zoomFactorFor(e.deltaY, e.deltaMode);
      if (factor === 1) return;

      const before = this.pdfViewer.currentScale;
      const after = clampZoom(before * factor);
      if (after === before) return; // already at an end; nothing to do

      // Anchor on the pointer. Without this the viewer zooms towards its own
      // centre and the point under the cursor slides away, so the user has to
      // scroll back after every notch.
      const origin = [
        e.clientX - this.container.getBoundingClientRect().left + this.container.scrollLeft,
        e.clientY - this.container.getBoundingClientRect().top + this.container.scrollTop,
      ] as [number, number];

      this.pdfViewer.updateScale({ scaleFactor: factor, origin });
      this.onScaleChanged?.();
    }, { passive: false });
  }

  async init(): Promise<void> {
    const { EventBus, PDFLinkService, PDFViewer } = await getViewerModule();
    this.eventBus = new EventBus();
    this.linkService = new PDFLinkService({ eventBus: this.eventBus });

    this.pdfViewer = new PDFViewer({
      container: this.container,
      viewer: this.viewerEl,
      eventBus: this.eventBus,
      linkService: this.linkService,
      annotationEditorMode: AnnotationEditorType.NONE,
      textLayerMode: 1, // ENABLE
      removePageBorders: false,
    });

    // AnnotationEditorUIManager is created inside PDFViewer#setDocument() and
    // handed out through this event. Its constructor takes 15 private args and
    // the class is not exported, so this is the only supported acquisition path.
    this.eventBus.on(
      "annotationeditoruimanager",
      (e: { uiManager: unknown }) => {
        this.uiManager = e.uiManager;
        this.diagnostics.log("info", "AnnotationEditorUIManager acquired");
      }
    );

    this.eventBus.on("annotationeditorstatechanged", () => {
      this.markDirty(true);
    });

    this.wireWheelZoom();

    this.diagnostics.log("success", `PDF.js ${PDFJS_VERSION} viewer initialised`);
  }

  get eventBusInstance() {
    return this.eventBus;
  }

  get hasUIManager(): boolean {
    return !!this.uiManager;
  }

  get numPages(): number {
    return this.doc?.numPages ?? 0;
  }

  get scale(): number {
    return this.pdfViewer.currentScale;
  }

  get isDirty(): boolean {
    return this.dirtyFlag || this.pendingInkExists();
  }

  markClean(): void {
    // Always notify, even when the flag was already false: the shell also
    // uses this to refresh the document name / title after an open.
    this.dirtyFlag = false;
    this.onDirtyChange?.(false);
  }

  /* ---------------------------------------------------------------- Open -- */

  async open(src: Uint8Array | string, name: string): Promise<number> {
    await this.close();

    const params: Record<string, unknown> = {
      cMapUrl: "cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "standard_fonts/",
    };
    if (typeof src === "string") params.url = src;
    else params.data = src;

    const doc = await pdfjsLib.getDocument(params as Parameters<typeof pdfjsLib.getDocument>[0]).promise;
    this.doc = doc;
    this.documentName = name;
    this.documentSource = typeof src === "string" ? src : "";

    // Triggers UIManager creation + the "annotationeditoruimanager" event.
    await this.pdfViewer.setDocument(doc);
    this.linkService.setViewer(this.pdfViewer);

    // PDFViewer only sizes pages from #setScale. Two facts make this fiddly:
    //   * the preset branch early-returns while `_currentPageNumber` is 0;
    //   * setting `currentPageNumber` during open throws inside PDF.js
    //     (`_setCurrentPageNumber` -> a page view whose `div` is not built yet).
    // So we always drive the NUMERIC branch and compute fit ourselves.
    await this.applyScale(await this.numericFitScale("page"));

    // Wait for the editor subsystem; without it Highlight/Ink cannot work.
    for (let i = 0; i < 60 && !this.uiManager; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!this.uiManager) {
      this.diagnostics.log("warn", "UIManager not available after open()");
    }

    this.dirtyFlag = false;
    await this.setTool("select");
    this.diagnostics.log("success", `Opened "${name}" — ${doc.numPages} page(s)`);
    return doc.numPages;
  }

  async close(): Promise<void> {
    if (this.doc) {
      try {
        await this.pdfViewer.setDocument(null as unknown as PDFDocumentProxy);
      } catch {
        /* ignore: viewer may already be torn down */
      }
      // 6.4.299: PDFDocumentProxy exposes cleanup(), NOT destroy()
      // (destroy() lives on PDFDocumentLoadingTask). Calling destroy() here
      // would throw.
      try {
        await this.doc.cleanup();
      } catch {
        /* ignore */
      }
      this.doc = null;
      this.pageText.clear();
    }
    this.uiManager = null;
  }

  /* ---------------------------------------------------------------- Tools -- */

  async setTool(tool: ToolMode): Promise<void> {
    this.tool = tool;
    if (!this.uiManager) return;

    // Leaving ink must flush the pending stroke first (see class doc).
    if (tool !== "ink") this.commitPendingInk();

    const mode =
      tool === "select"
        ? AnnotationEditorType.NONE
        : tool === "highlight"
          ? AnnotationEditorType.HIGHLIGHT
          : AnnotationEditorType.INK;

    // Argument 3 (`isFromUser = true`) is REQUIRED: it makes PDF.js reset its
    // module-level `CurrentPointers` state. Without it a second stroke is
    // dropped by an early return in DrawingEditor.startDrawing().
    await this.uiManager.updateMode?.(mode, null, true);
    this.diagnostics.log("info", `Tool -> ${tool} (mode=${mode})`);
  }

  get currentTool(): ToolMode {
    return this.tool;
  }

  /**
   * Turn the current DOM selection into a real Highlight annotation.
   *
   * Ordering matters (verified): the text must already be selected while in
   * Select mode; we then enter HIGHLIGHT mode (the DOM selection survives the
   * switch) before calling the public `highlightSelection()`.
   *
   * Returns how many annotations were **created by this call**, not the total.
   * Returning the total made the caller treat a failed highlight on a document
   * that already had highlights as a success — which is how "highlight did
   * nothing" could still look like it worked.
   */
  async highlightSelection(): Promise<number> {
    if (!this.uiManager) {
      this.diagnostics.log("error", "Highlight: AnnotationEditorUIManager unavailable");
      return 0;
    }
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      this.diagnostics.log("warn", "Highlight: no text selected");
      return 0;
    }
    const before = this.annotationCount();
    try {
      await this.uiManager.updateMode?.(AnnotationEditorType.HIGHLIGHT, null, true);
      await this.ensureHighlightReady();
      // The conversion reads the *current* selection, and the mode changes above
      // can take it with them.
      const kept = captureSelection();
      restoreSelection(kept);
      this.uiManager.highlightSelection();
      // Poll rather than sleep: the editor is created synchronously, but the
      // count is what tells us it worked, and a fixed wait is a race with a
      // machine that is busy.
      const made = await this.waitForAnnotationCount(before, 1500);
      if (made > 0) this.markDirty(true);
      this.diagnostics.log("success", `Highlight created — +${made} (total=${before + made})`);
      return made;
    } catch (e) {
      this.diagnostics.log("error", `Highlight failed: ${String(e)}`);
      return 0;
    }
  }

  /**
   * Make sure the current page can actually produce a highlight.
   *
   * PDF.js attaches the pointer listener that turns a drag into a highlight
   * when the annotation editor layer's `updateMode` runs — and only if that
   * page's text layer had been rendered by then. A page rendered *after* the
   * mode switch never gets the listener, and PDF.js does not re-apply the mode
   * when the text layer appears. The page then silently refuses to highlight,
   * until the mode is toggled and applied a second time.
   *
   * That is the whole of the reported symptom: the highlight button did
   * nothing, and switching to select and back made it work.
   *
   * The check reads the class PDF.js itself sets (`highlighting` on the text
   * layer), so it asks the same question the browser does rather than guessing
   * at PDF.js's internals.
   */
  private async ensureHighlightReady(): Promise<void> {
    const layer = this.textLayerDiv();
    if (!layer || layer.classList.contains("highlighting")) return;

    this.diagnostics.log("warn", "Highlight: page text layer not in highlight mode — re-applying");
    // Keep the selection across the round trip: leaving highlight mode aborts
    // the text layer's pointer listener, and the conversion needs the words.
    const kept = captureSelection();
    await this.uiManager?.updateMode?.(AnnotationEditorType.NONE, null, true);
    await this.uiManager?.updateMode?.(AnnotationEditorType.HIGHLIGHT, null, true);
    restoreSelection(kept);
  }

  /** The text layer of the page on screen, if it has been rendered. */
  private textLayerDiv(): HTMLElement | null {
    const page = this.currentPage;
    const pg = document.querySelector(`.page[data-page-number="${page}"]`);
    return pg?.querySelector<HTMLElement>(".textLayer") ?? null;
  }

  /**
   * Wait until the annotation count grows, or give up.
   *
   * The editor is created synchronously by `highlightSelection()`, but reading
   * the count is what proves it worked. A fixed sleep is a race with a busy
   * machine; this asks the question instead.
   */
  private async waitForAnnotationCount(before: number, timeoutMs: number): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const made = this.annotationCount() - before;
      if (made > 0) return made;
      if (Date.now() >= deadline) return 0;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /**
   * Is the viewport point on top of an annotation editor?
   *
   * Used to tell "clicked a highlight / ink stroke" from "clicked empty paper",
   * which is the whole difference between erasing what the user aimed at and
   * deleting whatever happened to be selected.
   *
   * Every editor's root div carries `data-editor-rotation` (see
   * `AnnotationEditor.render` in the pinned pdfjs-dist), and each editor's own
   * geometry is drawn inside that div — so walking up from the hit element is
   * enough. Deliberately does NOT reach into `AnnotationEditorUIManager`'s
   * private `#editors` map: if a future pdfjs-dist renames the attribute, this
   * degrades to "no hit detected" and erasing simply stops working, rather than
   * throwing or deleting the wrong annotation.
   */
  isPointOnAnnotation(x: number, y: number): boolean {
    let node: Element | null = null;
    try {
      node = document.elementFromPoint(x, y);
    } catch {
      return false;
    }
    for (let depth = 0; node && depth < 8; depth++) {
      if (node.hasAttribute?.("data-editor-rotation")) return true;
      node = node.parentElement;
    }
    return false;
  }

  /**
   * True while an ink stroke has been drawn but not yet committed.
   * `InkEditor.supportMultipleDrawings === true` makes DrawingEditor._endDraw
   * return early on pointer-up, so the stroke lives on a temporary canvas
   * until the drawing session ends.
   */
  pendingInkExists(): boolean {
    try {
      if (this.uiManager?.getMode?.() !== AnnotationEditorType.INK) return false;
      const layer = this.uiManager?.currentLayer;
      if (layer?.div?.classList?.contains("drawing")) return true;
      // Fall back to a direct probe of the shared drawing layer.
      const anyDrawing = document.querySelector(".annotationEditorLayer.drawing");
      return !!anyDrawing;
    } catch {
      return false;
    }
  }

  /** Flush a pending ink stroke into a real `/Subtype /Ink` annotation. */
  commitPendingInk(): void {
    try {
      const mgr = this.uiManager;
      if (!mgr) return;
      const before = this.annotationCount();

      if (mgr.getMode?.() === AnnotationEditorType.INK) {
        for (let i = 0; i < 32; i++) {
          const layer = mgr.getLayer?.(i);
          layer?.endDrawingSession?.();
        }
        mgr.currentLayer?.endDrawingSession?.();
      }
      mgr.currentLayer?.commitOrRemove?.();

      // A committed stroke is a real document modification — the shell must
      // learn about it even when the pointer never reached its mouseup handler.
      if (this.annotationCount() > before) this.markDirty(true);
    } catch (e) {
      this.diagnostics.log("warn", `commitPendingInk: ${String(e)}`);
    }
  }

  /** Remove the currently selected editor (real delete, not white paint). */
  deleteSelected(): boolean {
    try {
      const mgr = this.uiManager;
      if (!mgr) return false;
      const hadSelection = !!mgr.hasSelection;
      if (typeof mgr.delete === "function") {
        mgr.delete();
        this.markDirty(true);
        this.diagnostics.log("info", `delete() issued (hadSelection=${hadSelection})`);
        return hadSelection;
      }
      return false;
    } catch (e) {
      this.diagnostics.log("warn", `deleteSelected: ${String(e)}`);
      return false;
    }
  }

  /** Diagnostics snapshot used by the automated suites. */
  debugState(): Record<string, unknown> {
    const mgr = this.uiManager as any;
    return {
      mode: mgr?.getMode?.() ?? null,
      hasSelection: !!mgr?.hasSelection,
      hasSomethingToControl: !!mgr?.hasSomethingToControl?.(),
      currentTool: this.tool,
      isDirty: this.isDirty,
      annotationCount: this.annotationCount(),
    };
  }

  undo(): void {
    try {
      this.uiManager?.undo?.();
      this.markDirty(true);
    } catch (e) {
      this.diagnostics.log("warn", `undo: ${String(e)}`);
    }
  }

  /* --------------------------------------------------------------- Counting */

  /**
   * Number of annotations currently held by the document.
   *
   * `AnnotationEditorUIManager`'s storage field is private in 6.x, but the same
   * instance is exposed publicly as `pdfDocument.annotationStorage`. Its inner
   * Map is private too, so we count rendered editors (ground truth for what the
   * user sees) and cross-check the storage accessors.
   */
  annotationCount(): number {
    const dom = document.querySelectorAll(
      ".pdfViewer .annotationEditorLayer .highlightEditor, " +
        ".pdfViewer .annotationEditorLayer .inkEditor, " +
        ".pdfViewer .annotationEditorLayer .freeTextEditor, " +
        ".pdfViewer .annotationEditorLayer .stampEditor, " +
        ".pdfViewer .annotationEditorLayer .signatureEditor"
    ).length;
    if (dom > 0) return dom;

    const st = (this.doc as unknown as { annotationStorage?: any })?.annotationStorage;
    const direct = st?.serializable?.size ?? st?._storage?.size;
    return typeof direct === "number" ? direct : 0;
  }

  /* ------------------------------------------------------------------ Zoom */

  /** Padding PDF.js uses when fitting (SCROLLBAR_PADDING / VERTICAL_PADDING). */
  private static readonly H_PAD = 40;
  private static readonly V_PAD = 9;

  /**
   * Compute a fit scale numerically against the first page.
   * Avoids `currentScaleValue` presets entirely — see open() for why.
   */
  private async numericFitScale(mode: "width" | "page"): Promise<number> {
    if (!this.doc) return 1;
    try {
      const page = await this.doc.getPage(1);
      const vp = page.getViewport({ scale: 1 });
      const w = (this.container.clientWidth - PdfjsAdapter.H_PAD) / vp.width;
      const h = (this.container.clientHeight - PdfjsAdapter.V_PAD) / vp.height;
      const s = mode === "width" ? w : Math.min(w, h);
      return Math.min(10, Math.max(0.1, s || 1));
    } catch (e) {
      this.diagnostics.log("warn", `numericFitScale failed: ${String(e)}`);
      return 1;
    }
  }

  private async applyScale(scale: number): Promise<void> {
    this.pdfViewer.currentScale = scale;
    this.onScaleChanged?.();
  }

  setZoom(scale: number): void {
    this.pdfViewer.currentScale = Math.min(10, Math.max(0.1, scale));
    this.onScaleChanged?.();
  }

  zoomBy(factor: number): void {
    this.setZoom(this.pdfViewer.currentScale * factor);
  }

  async fitWidth(): Promise<void> {
    await this.applyScale(await this.numericFitScale("width"));
  }

  async fitPage(): Promise<void> {
    await this.applyScale(await this.numericFitScale("page"));
  }

  /** Notified whenever the scale changes so the UI can refresh the label. */
  onScaleChanged: (() => void) | null = null;

  /* ------------------------------------------------------------------ Save */

  /**
   * Serialise the document with all pending edits committed.
   * Returns the raw PDF bytes; the caller must NOT write them to disk itself
   * (that is the Rust DocumentSaveService's job).
   */
  async serialize(): Promise<Uint8Array> {
    if (!this.doc) throw new Error("No document open");

    // CRITICAL: an uncommitted ink stroke never reaches saveDocument().
    if (this.uiManager?.getMode?.() === AnnotationEditorType.INK || this.pendingInkExists()) {
      this.commitPendingInk();
      await new Promise((r) => setTimeout(r, 400));
    }

    this.diagnostics.log("info", "saveDocument() starting…");
    const data = await this.doc.saveDocument();
    this.diagnostics.log("success", `saveDocument() OK — ${data.byteLength} bytes`);
    return data;
  }

  /* ------------------------------------------------------------- Structure */

  /** Re-open `bytes` in a FRESH document and report the annotations found. */
  async verify(bytes: Uint8Array): Promise<VerifyReport> {
    const countsBySubtype: Record<string, number> = {};
    const samples: AnnotationSample[] = [];
    let doc: PDFDocumentProxy | null = null;

    try {
      doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
      for (let p = 1; p <= doc.numPages; p++) {
        const page = await doc.getPage(p);
        const annots = await page.getAnnotations({ intent: "display" });
        for (const a of annots) {
          const t = String((a as { subtype?: string }).subtype ?? "unknown");
          countsBySubtype[t] = (countsBySubtype[t] ?? 0) + 1;
          if (samples.length < 8) {
            samples.push({
              page: p,
              subtype: t,
              rect: Array.isArray(a.rect) ? (a.rect as number[]) : null,
              quadPoints: Array.isArray(a.quadPoints) ? (a.quadPoints as number[]) : null,
              inkStrokes: Array.isArray((a as any).inkLists) ? (a as any).inkLists.length : null,
              color: a.color ?? null,
            });
          }
        }
        page.cleanup();
      }
      const report: VerifyReport = {
        numPages: doc.numPages,
        countsBySubtype,
        samples,
        hasHighlight: (countsBySubtype["Highlight"] ?? 0) > 0,
        hasInk: (countsBySubtype["Ink"] ?? 0) > 0,
      };
      this.diagnostics.log("info", `Verify: ${JSON.stringify(countsBySubtype)}`);
      return report;
    } catch (e) {
      return {
        numPages: 0,
        countsBySubtype,
        samples,
        hasHighlight: false,
        hasInk: false,
        error: String(e),
      };
    } finally {
      await (doc as unknown as { cleanup?: () => Promise<void> })?.cleanup?.().catch(() => undefined);
    }
  }

  /* -------------------------------------------------------------- Geometry */

  /**
   * Text-layer spans matching `needle`, with viewport geometry.
   *
   * NOTE: this used to live on the adapter, but its only caller was the
   * automation test bridge. It now lives there instead, so the release bundle
   * genuinely does not contain it (K-03) rather than merely not exposing it.
   */

  /**
   * Extracted text of one page (1-based), for AI context building.
   *
   * Read-only and side-effect free: it never changes the selection, the tool or
   * the scroll position. Returns "" when the page carries no text (a scanned
   * page), which the caller must surface as "no selectable text" rather than
   * pretending OCR happened.
   *
   * **This reads the document, not the rendered DOM.** It used to read the
   * `.textLayer` element, and that was the bug: PDF.js builds a page's text
   * layer inside `PDFPageView#draw()`, which only runs for pages it has actually
   * rendered, and rendering is virtualised by visibility. So a page the user had
   * not scrolled to had no text layer and read as empty — the same result as a
   * genuinely scanned page. Opening a paper and asking about it before the
   * renderer caught up produced "未能提取到文本" for a document with text on
   * every page, which is exactly the failure that was reported.
   *
   * `getTextContent()` asks the document directly and has no such dependency:
   * the answer does not change with scroll position, zoom, or how long the
   * document has been open. It is also the source the text layer is rendered
   * from, so "matches what the user can select" still holds — the layer is a
   * positioned view of this same content, not different content.
   *
   * Results are cached per page: `whole-document` mode walks every page, and
   * `getTextContent()` is a worker round-trip that would otherwise be repeated
   * on every question in a reading session.
   */
  async getPageText(pageNumber: number): Promise<string> {
    const cached = this.pageText.get(pageNumber);
    if (cached !== undefined) return cached;

    if (!this.doc) return "";
    let text = "";
    try {
      const page = await this.doc.getPage(pageNumber);
      const content = await page.getTextContent();
      // `getTextContent()` types its items as a union that includes
      // marked-content containers, which carry no `str` of their own. Those
      // only appear when `includeMarkedContent` is set, which this does not
      // ask for; narrow structurally anyway so the union cannot reach the
      // composer on the strength of a cast.
      const items = content.items.filter((i) => "str" in i);
      text = textFromContentItems(items);
    } catch (e) {
      // A page that cannot be read is not a reason to fail the question; the
      // caller already knows how to report a page with no text.
      this.diagnostics.log("warn", `getPageText(${pageNumber}): ${String(e)}`);
    }
    this.pageText.set(pageNumber, text);
    return text;
  }

  /**
   * The text inside a rectangle of the rendered page.
   *
   * The reader selects a region on the canvas; the text layer of the same page
   * holds exactly the words in that region. Reading them is free and exact,
   * where an OCR pass would be a guess and a scan would have no text at all.
   *
   * The rectangle arrives in *canvas* pixels and is converted to PDF user space
   * here, because this is the only place that knows the page's size. The scale
   * is derived from the canvas width against the page's own width at scale 1,
   * which is exact whatever the zoom and the device pixel ratio happen to be.
   *
   * Returns an empty string when the page has no text layer — a scan — so the
   * caller can fall back to the image without a second code path.
   */
  async getRegionText(
    pageNumber: number,
    canvasRect: { x: number; y: number; width: number; height: number },
    canvasWidth: number
  ): Promise<string> {
    if (!this.doc) return "";
    try {
      const page = await this.doc.getPage(pageNumber);
      const base = page.getViewport({ scale: 1 });
      if (!base.width || !base.height) return "";

      // Canvas pixels per PDF user unit.
      const k = canvasWidth / base.width;
      if (!Number.isFinite(k) || k <= 0) return "";

      // Canvas y grows downward from the top; user space grows upward from the
      // bottom. The region has to be flipped, or it selects the mirror image
      // of the text — a page of text in reverse order.
      const top = base.height - canvasRect.y / k;
      const bottom = base.height - (canvasRect.y + canvasRect.height) / k;

      const content = await page.getTextContent();
      const items = content.items.filter(
        (i): i is typeof i & { str: string; transform: number[]; width: number; height: number } =>
          "str" in i && Array.isArray((i as { transform?: unknown }).transform)
      );
      return textInRegion(items, {
        x: canvasRect.x / k,
        y: Math.min(bottom, top),
        width: canvasRect.width / k,
        height: Math.abs(top - bottom),
      });
    } catch (e) {
      this.diagnostics.log("warn", `getRegionText(${pageNumber}): ${String(e)}`);
      return "";
    }
  }

  /**
   * Render a page to an image, straight from the document.
   *
   * Deliberately NOT `pageCanvas()`. That reads the canvas the viewer already
   * painted, which makes the result depend on what has been rendered — the exact
   * dependency that produced A-26 for text. A page the user has not scrolled to
   * has no canvas, so whole-document image mode would silently skip pages.
   *
   * Rendering from the document instead means the answer does not change with
   * scroll position, zoom, or how long the document has been open.
   *
   * JPEG, not PNG. A scanned page is a photograph: PNG is lossless and would be
   * several times larger for detail nobody asked to preserve, and the payload is
   * capped anyway. The region-screenshot ladder prefers PNG because line art and
   * formulas ring under JPEG's 8×8 blocks; that reasoning does not apply to a
   * page-sized scan, and the budget matters far more at this size.
   */
  async renderPageImage(
    pageNumber: number,
    maxEdge: number,
    quality = 0.82
  ): Promise<{ url: string; chars: number; width: number; height: number }> {
    if (!this.doc) throw new Error("No document open");
    const page = await this.doc.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    // Only ever shrink. Upscaling invents pixels and costs bytes for nothing.
    const scale = Math.min(1, maxEdge / Math.max(base.width, base.height));
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法创建画布上下文");
    // White matte first: a page's transparent margins would otherwise become
    // black in a format with no alpha.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // `canvas` as well as `canvasContext`: the type requires both, and passing
    // only the context is a compile error rather than a runtime one.
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;

    const url = canvas.toDataURL("image/jpeg", quality);
    return { url, chars: url.length, width: canvas.width, height: canvas.height };
  }

  /**
   * True when this page carries no extractable text (scanned / empty page).
   *
   * Async for the same reason `getPageText` is: it reads the document.
   */
  async pageHasText(pageNumber: number): Promise<boolean> {
    return (await this.getPageText(pageNumber)).length > 0;
  }

  /** 1-based page currently at the top of the viewport. */
  get currentPage(): number {
    const n = (this.pdfViewer as unknown as { currentPageNumber?: number })?.currentPageNumber;
    return typeof n === "number" && n > 0 ? n : 1;
  }
}
