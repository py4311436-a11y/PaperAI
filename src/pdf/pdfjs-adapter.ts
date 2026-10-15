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
    this.markDirty(false);
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
    try {
      await this.uiManager.updateMode?.(AnnotationEditorType.HIGHLIGHT, null, true);
      await new Promise((r) => setTimeout(r, 200));
      this.uiManager.highlightSelection();
      await new Promise((r) => setTimeout(r, 350));
      this.markDirty(true);
      const n = this.annotationCount();
      this.diagnostics.log("success", `Highlight created — annotations=${n}`);
      return n;
    } catch (e) {
      this.diagnostics.log("error", `Highlight failed: ${String(e)}`);
      return 0;
    }
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

  /** Text-layer spans matching `needle`, with viewport geometry. */
  getSpanRects(needle: string, limit = 8): Array<{ text: string; x: number; y: number; w: number; h: number; page: number }> {
    const out: Array<{ text: string; x: number; y: number; w: number; h: number; page: number }> = [];
    this.container.querySelectorAll<HTMLElement>(".page").forEach((pg) => {
      const pageNo = Number(pg.dataset.pageNumber ?? 0);
      pg.querySelectorAll<HTMLElement>(".textLayer span").forEach((s) => {
        if (out.length >= limit) return;
        if ((s.textContent ?? "").includes(needle)) {
          const b = s.getBoundingClientRect();
          out.push({ text: (s.textContent ?? "").slice(0, 60), x: b.x, y: b.y, w: b.width, h: b.height, page: pageNo });
        }
      });
    });
    return out;
  }
}
