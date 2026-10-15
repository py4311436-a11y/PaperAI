/* PaperAI — application shell.
 *
 * Responsibilities: toolbar wiring, dirty-state policy, and the guarded
 * open/save flows. ALL PDF.js specifics live in src/pdf/pdfjs-adapter.ts and
 * ALL Tauri IPC lives in src/bridge.ts — this file must stay version-agnostic.
 */
import {
  Diagnostics,
  PdfjsAdapter,
  PDFJS_VERSION,
  type ToolMode,
  type VerifyReport,
} from "./pdf/pdfjs-adapter";
import * as bridge from "./bridge";
import "./style.css";

// ---------------------------------------------------------------- DOM
const $ = <T extends HTMLElement = HTMLElement>(sel: string): T =>
  document.querySelector(sel) as T;

const viewerContainer = $<HTMLDivElement>("#viewerContainer");
const viewerEl = $<HTMLDivElement>("#viewer");
const statusFile = $("#status-file");
const statusAnnot = $("#status-annot");
const statusSel = $("#status-sel");
const statusDirty = $("#status-dirty");
const pageIndicator = $("#page-indicator");
const zoomLabel = $("#zoom-label");
const toastEl = $("#toast");

const diagnostics = new Diagnostics();
// Mirror adapter diagnostics to the console so WebView2 devtools show them too.
diagnostics.on((e) => {
  if (e.level === "error") console.error("[PaperAI]", e.msg);
  else if (e.level === "warn") console.warn("[PaperAI]", e.msg);
  else console.log("[PaperAI]", e.msg);
});

const adapter = new PdfjsAdapter({
  container: viewerContainer,
  viewer: viewerEl,
  diagnostics,
});
// Single source of truth for the dirty flag: the adapter knows when an
// annotation is created or removed, the shell only reflects it.
adapter.onDirtyChange = (d) => setDirty(d);

// ---------------------------------------------------------------- state
let currentPath: string | null = null;
let currentName = "";
let dirty = false;
let lastVerify: VerifyReport | null = null;
let lastSavedBytes: Uint8Array | null = null;

function setDirty(v: boolean) {
  dirty = v;
  statusDirty.textContent = v ? "● 未保存" : "";
  statusDirty.style.color = v ? "#d1242f" : "";
  syncTitle();
}

/**
 * Mirror the open document into the native window title.
 *
 * Besides being good UX, this makes the OS-level state observable: the
 * automated desktop tests read the native title to prove which PDF the real
 * installed app is showing (no way to reach into the WebView otherwise).
 */
async function syncTitle() {
  // "· ready" is a deliberate marker: it distinguishes "frontend booted" from
  // the shell's static window title, which lets automated runs confirm the
  // WebView actually executed our bundle.
  const base = `PaperAI${currentName ? " — " + currentName : " · ready"}${dirty ? " *" : ""}`;
  document.title = base;
  if (!bridge.isTauri) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setTitle(base);
  } catch {
    /* capability missing — cosmetic only */
  }
}

function toast(msg: string, kind: "info" | "error" | "success" | "warn" = "info") {
  toastEl.textContent = msg;
  toastEl.className = kind;
  toastEl.style.display = "block";
  clearTimeout((toastEl as unknown as { _t?: number })._t);
  (toastEl as unknown as { _t?: number })._t = window.setTimeout(() => {
    toastEl.style.display = "none";
  }, kind === "error" ? 7000 : 3000);
}

// ---------------------------------------------------------------- open
async function openPath(rawPath: string): Promise<boolean> {
  try {
    const info = await bridge.invokeOpen(rawPath);
    const bytes = await bridge.readPdf(info.path);
    await adapter.open(bytes, info.name);
    currentPath = info.path;
    currentName = info.name;
    statusFile.textContent = `${info.name} — ${adapter.numPages} 页`;
    adapter.markClean();
    toast(`已打开 ${info.name}`, "success");
    return true;
  } catch (e) {
    diagnostics.log("error", `openPath failed: ${String(e)} :: ${e instanceof Error ? e.stack : "no stack"}`);
    const msg = String(e);
    statusFile.textContent = `打开失败: ${msg}`;
    toast(`打开失败: ${msg}`, "error");
    return false;
  }
}

/** Open, but honour the dirty guard (save / discard / cancel). */
async function guardedOpen(rawPath: string): Promise<boolean> {
  if (dirty) {
    const decision = await bridge.askDirty(currentName);
    if (decision === "cancel") return false;
    if (decision === "save") {
      const ok = await saveTo(currentPath);
      if (!ok) return false; // save failed -> keep the document, do not switch
    }
  }
  return await openPath(rawPath);
}

async function onOpenClicked() {
  const picked = await bridge.pickPdf();
  if (!picked) return;
  await guardedOpen(picked.path);
}

// ---------------------------------------------------------------- save
async function saveTo(target: string | null): Promise<boolean> {
  if (!adapter.numPages) {
    toast("没有打开的文档", "error");
    return false;
  }
  const dest = target ?? (await bridge.pickSaveTarget(currentName || "document.pdf"));
  if (!dest) return false;

  try {
    // 1. commit pending ink + serialise (adapter guarantees the flush)
    const bytes = await adapter.serialize();
    // 2. structural re-open check BEFORE touching the user's file
    const report = await adapter.verify(bytes);
    if (report.error) {
      toast(`保存中止：生成的 PDF 无法解析 (${report.error})`, "error");
      return false;
    }
    if (!bridge.isTauri) {
      // Browser fallback (used by the automated regression suite).
      lastSavedBytes = bytes;
      lastVerify = report;
      const blob = new Blob([bytes.slice()], { type: "application/pdf" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = dest.replace(/^.*[\\/]/, "").replace(/\.pdf$/i, "") + "_annotated.pdf";
      document.body.appendChild(a);
      a.click();
      a.remove();
      adapter.markClean();
      toast(`已导出 ${bytes.byteLength} 字节`, "success");
      return true;
    }

    const res = await bridge.saveDocument({
      target_path: dest,
      data_base64: bridge.toBase64(bytes),
      make_backup: true,
    });
    if (!res.ok) {
      // dirty is intentionally NOT cleared
      toast(`保存失败 [${res.code}] ${res.message}`, "error");
      return false;
    }
    currentPath = res.target;
    currentName = res.target.replace(/^.*[\\/]/, "");
    statusFile.textContent = `${currentName} — ${adapter.numPages} 页`;
    adapter.markClean();
    lastSavedBytes = bytes;
    lastVerify = report;
    toast(`已保存 ${res.bytes} 字节 (SHA256 ${res.sha256.slice(0, 12)}…)`, "success");
    return true;
  } catch (e) {
    toast(`保存异常: ${String(e)}`, "error");
    return false;
  }
}

async function onSave() {
  if (!currentPath) {
    await saveTo(null);
    return;
  }
  await saveTo(currentPath);
}

async function onSaveAs() {
  await saveTo(null);
}

// ---------------------------------------------------------------- tools
async function setTool(tool: ToolMode) {
  document.querySelectorAll(".tool").forEach((b) => b.classList.remove("active"));
  $(`#btn-${tool === "ink" ? "ink" : tool}`).classList.add("active");
  await adapter.setTool(tool);
}

// ---------------------------------------------------------------- wiring
$("#btn-open").addEventListener("click", () => void onOpenClicked());
$("#btn-select").addEventListener("click", () => void setTool("select"));
$("#btn-highlight").addEventListener("click", async () => {
  const n = await adapter.highlightSelection();
  if (n > 0) setDirty(true);
  else toast("请先在选择模式下选中一段文字", "warn");
});
$("#btn-ink").addEventListener("click", () => void setTool("ink"));
$("#btn-erase").addEventListener("click", async () => {
  // PDF.js only makes the editor layer hit-testable while an editing mode is
  // active (`.annotationEditorLayer.disabled { pointer-events: none }` and
  // `.highlightEditor { pointer-events: none }`). So selecting an annotation
  // we created ourselves requires entering an editing mode first.
  if (!adapter.debugState().hasSelection) {
    await setTool("ink");
    toast("已进入批注编辑模式：点击要删除的批注，再点 Erase", "info");
    return;
  }
  const ok = adapter.deleteSelected();
  if (ok) setDirty(true);
  else toast("没有选中的批注可删除", "info");
});
$("#btn-save").addEventListener("click", () => void onSave());
$("#btn-save-as").addEventListener("click", () => void onSaveAs());
$("#btn-zoom-in").addEventListener("click", () => {
  adapter.zoomBy(1.2);
  zoomLabel.textContent = `${Math.round(adapter.scale * 100)}%`;
});
$("#btn-zoom-out").addEventListener("click", () => {
  adapter.zoomBy(1 / 1.2);
  zoomLabel.textContent = `${Math.round(adapter.scale * 100)}%`;
});
$("#btn-fit-width").addEventListener("click", () => {
  void adapter.fitWidth();
  zoomLabel.textContent = `${Math.round(adapter.scale * 100)}%`;
});
$("#btn-fit-page").addEventListener("click", () => {
  void adapter.fitPage();
  zoomLabel.textContent = `${Math.round(adapter.scale * 100)}%`;
});

// NOTE: these must be registered from boot(), AFTER adapter.init() — at module
// scope the EventBus does not exist yet and `.on` would throw, killing the
// whole module before `window.__paperai` is ever installed.
function wireViewerEvents() {
  const bus = adapter.eventBusInstance;
  bus.on("pagechanging", (e: { pageNumber: number; pagesCount: number }) => {
    pageIndicator.textContent = `${e.pageNumber} / ${e.pagesCount}`;
  });
  bus.on("pagesinit", () => {
    // `pagesCount` is not carried by the 6.x event payload; read the document.
    pageIndicator.textContent = `1 / ${adapter.numPages}`;
    zoomLabel.textContent = `${Math.round(adapter.scale * 100)}%`;
  });
}

let raf = 0;
viewerContainer.addEventListener("mouseup", () => {
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(() => {
    const sel = window.getSelection();
    statusSel.textContent = sel && !sel.isCollapsed ? `选中: ${sel.toString().slice(0, 60)}` : "";
    (window as unknown as { __paperaiSelection: string }).__paperaiSelection = sel?.toString() ?? "";
    const n = adapter.annotationCount();
    statusAnnot.textContent = `批注: ${n}`;
    if (n > 0) setDirty(true);
  });
});

// Ctrl+S
window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    void onSave();
  }
});

// ---------------------------------------------------------------- single instance
async function drainPendingFiles() {
  if (!bridge.isTauri) return;
  const paths = await bridge.takePendingFiles();
  for (const p of paths) await guardedOpen(p);
}

bridge.onOpenFiles((paths) => {
  void (async () => {
    for (const p of paths) await guardedOpen(p);
  })();
});

// ---------------------------------------------------------------- boot
/**
 * Surface start-up failures through the NATIVE window title.
 *
 * In headless/automated environments we cannot always reach the WebView dev
 * console, but the OS window title is observable (Get-Process). Any uncaught
 * error during boot therefore ends up readable from outside.
 */
function reportFatal(where: string, err: unknown) {
  const msg = `ERR[${where}] ${String(err).slice(0, 160)}`;
  document.title = msg;
  if (!bridge.isTauri) return;
  void import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) => getCurrentWindow().setTitle(msg))
    .catch(() => undefined);
}

window.addEventListener("error", (e) => reportFatal("error", (e as ErrorEvent).message ?? e));
window.addEventListener("unhandledrejection", (e) => reportFatal("rejection", (e as PromiseRejectionEvent).reason));

async function boot() {
  await adapter.init();
  wireViewerEvents();

  // Browser-only fallback so the automated suite can run without Tauri.
  if (!bridge.isTauri) installBrowserFileFallback();

  await drainPendingFiles();
  if (!currentPath) statusFile.textContent = "未打开文件 — 点 Open 或拖入 PDF";
  (window as unknown as { __paperaiReady: boolean }).__paperaiReady = true;
  console.log(`[PaperAI] ready — PDF.js ${PDFJS_VERSION}, tauri=${bridge.isTauri}`);
}

function installBrowserFileFallback() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".pdf,application/pdf";
  input.id = "file-input";
  input.style.display = "none";
  document.body.appendChild(input);
  input.addEventListener("change", async () => {
    const f = input.files?.[0];
    if (!f) return;
    await adapter.open(new Uint8Array(await f.arrayBuffer()), f.name);
    currentName = f.name;
    currentPath = f.name;
    statusFile.textContent = `${f.name} — ${adapter.numPages} 页`;
    adapter.markClean();
  });
  (window as unknown as { __paperaiPickFile: () => void }).__paperaiPickFile = () => input.click();
}

boot().catch((e) => reportFatal("boot", e));

// ---------------------------------------------------------------- test API
Object.assign(window as unknown as Record<string, unknown>, {
  __paperai: {
    get version() {
      return PDFJS_VERSION;
    },
    get ready() {
      return !!(window as unknown as { __paperaiReady: boolean }).__paperaiReady;
    },
    get isTauri() {
      return bridge.isTauri;
    },
    get hasUIManager() {
      return adapter.hasUIManager;
    },
    get annotationCount() {
      return adapter.annotationCount();
    },
    get scale() {
      return adapter.scale;
    },
    get numPages() {
      return adapter.numPages;
    },
    get dirty() {
      return dirty;
    },
    get currentPath() {
      return currentPath;
    },
    get logs() {
      return diagnostics.all;
    },
    open: (p: string) => openPath(p),
    openRaw: (p: string) => openPath(p),
    loadByArrayBuffer: async (buf: ArrayBuffer, name: string) => {
      await adapter.open(new Uint8Array(buf), name);
      currentName = name;
      currentPath = null;
      statusFile.textContent = `${name} — ${adapter.numPages} 页`;
      adapter.markClean();
    },
    loadByUrl: async (url: string, name: string) => {
      await adapter.open(url, name);
      currentName = name;
      statusFile.textContent = `${name} — ${adapter.numPages} 页`;
      adapter.markClean();
    },
    setTool,
    setScale: (v: number) => {
      adapter.setZoom(v);
      zoomLabel.textContent = `${Math.round(adapter.scale * 100)}%`;
    },
    fitWidth: () => {
      void adapter.fitWidth();
      zoomLabel.textContent = `${Math.round(adapter.scale * 100)}%`;
    },
    fitPage: () => {
      void adapter.fitPage();
      zoomLabel.textContent = `${Math.round(adapter.scale * 100)}%`;
    },
    highlight: () => adapter.highlightSelection(),
    commitInk: () => adapter.commitPendingInk(),
    erase: () => adapter.deleteSelected(),
    undo: () => adapter.undo(),
    /** Serialise + verify WITHOUT writing anywhere. */
    serialize: () => adapter.serialize(),
    verify: (b: Uint8Array) => adapter.verify(b),
    save: async () => onSave(),
    saveAs: async () => onSaveAs(),
    get lastVerify() {
      return lastVerify;
    },
    get lastSavedBytes() {
      return lastSavedBytes;
    },
    getSelection: () => window.getSelection()?.toString() ?? "",
    debugState: () => adapter.debugState(),
    /** Direct access to the Rust save service (used by the save-safety suite). */
    saveRequest: (req: bridge.SaveRequest) => bridge.saveDocument(req),
    saveAsDialog: () => bridge.pickSaveTarget(currentName || "document.pdf"),
    getSpanRects: (needle: string, limit?: number) => adapter.getSpanRects(needle, limit),
    __verifyLoaded: async () => {
      const bytes = await adapter.serialize();
      return adapter.verify(bytes);
    },
  },
});
