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
  document.title = `PaperAI${currentName ? " — " + currentName : ""}${v ? " *" : ""}`;
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
    setDirty(false);
    toast(`已打开 ${info.name}`, "success");
    return true;
  } catch (e) {
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
      setDirty(false);
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
    setDirty(false);
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
$("#btn-erase").addEventListener("click", () => {
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
  adapter.fitWidth();
  zoomLabel.textContent = `${Math.round(adapter.scale * 100)}%`;
});
$("#btn-fit-page").addEventListener("click", () => {
  adapter.fitPage();
  zoomLabel.textContent = `${Math.round(adapter.scale * 100)}%`;
});

adapter.eventBusInstance.on("pagechanging", (e: { pageNumber: number; pagesCount: number }) => {
  pageIndicator.textContent = `${e.pageNumber} / ${e.pagesCount}`;
});
adapter.eventBusInstance.on("pagesinit", (e: { pagesCount: number }) => {
  pageIndicator.textContent = `1 / ${e.pagesCount}`;
  zoomLabel.textContent = `${Math.round(adapter.scale * 100)}%`;
});

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
async function boot() {
  await adapter.init();

  // Browser-only fallback so the automated suite can run without Tauri.
  if (!bridge.isTauri) installBrowserFileFallback();

  await drainPendingFiles();
  statusFile.textContent = "未打开文件 — 点 Open 或拖入 PDF";
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
    setDirty(false);
  });
  (window as unknown as { __paperaiPickFile: () => void }).__paperaiPickFile = () => input.click();
}

void boot();

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
      setDirty(false);
    },
    loadByUrl: async (url: string, name: string) => {
      await adapter.open(url, name);
      currentName = name;
      statusFile.textContent = `${name} — ${adapter.numPages} 页`;
      setDirty(false);
    },
    setTool,
    setScale: (v: number) => {
      adapter.setZoom(v);
      zoomLabel.textContent = `${Math.round(adapter.scale * 100)}%`;
    },
    fitWidth: () => {
      adapter.fitWidth();
      zoomLabel.textContent = `${Math.round(adapter.scale * 100)}%`;
    },
    fitPage: () => {
      adapter.fitPage();
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
    getSpanRects: (needle: string, limit?: number) => adapter.getSpanRects(needle, limit),
    __verifyLoaded: async () => {
      const bytes = await adapter.serialize();
      return adapter.verify(bytes);
    },
  },
});
