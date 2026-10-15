/* PaperAI — application shell.
 *
 * Responsibilities: toolbar wiring, dirty-state policy, guarded open/save, and
 * gluing the AI panel to the PDF. ALL PDF.js specifics live in
 * src/pdf/pdfjs-adapter.ts, ALL Tauri IPC lives in src/bridge.ts, and the AI
 * logic lives in src/ai/* — this file must stay thin.
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
import "./ai/style.css";
// KaTeX stylesheet + fonts, bundled locally on purpose: a CDN stylesheet would
// be a third-party request made from inside the app.
import "katex/dist/katex.min.css";

import { ChatController } from "./ai/chat-controller";
import { ChatPanel, humanError } from "./ai/chat-panel";
import { ProviderSettings } from "./ai/provider-settings";
import { SelectionBar } from "./ai/selection-bar";
import { buildContext, PRESET_PROMPTS } from "./ai/context-builder";
import {
  captureSelection,
  installSelectionTracking,
  isSnapshotCurrent,
  type SelectionSnapshot,
} from "./ai/selection-snapshot";
import type { ContextMode } from "./ai/types";

/** Build-time flag. `automation` builds keep the test bridge; releases do not. */
const IS_AUTOMATION = import.meta.env.VITE_PAPERAI_AUTOMATION === "1";

/**
 * Readiness marker.
 *
 * Deliberately the ONLY thing the release build may expose on `window`, and it
 * is a read-only boolean rather than a callable interface: the automated
 * desktop suites wait on it to know the WebView executed our bundle, which is
 * how they distinguish "frontend booted" from "window exists but is blank".
 * `scripts/verify-release-bundle.mjs` asserts nothing beyond this survives.
 */
const READY_FLAG = "__paperai_ready";

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
const viewerWrap = $("#viewer-wrap");

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
/** Stable identity of the open document, used to isolate AI sessions. */
let currentDocumentId: string | null = null;
let dirty = false;
let lastVerify: VerifyReport | null = null;
let lastSavedBytes: Uint8Array | null = null;
let selection: SelectionSnapshot | null = null;

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
 * installed app is showing (the WebView is otherwise unreachable — K-13).
 */
async function syncTitle() {
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
  (toastEl as unknown as { _t?: number })._t = window.setTimeout(
    () => {
      toastEl.style.display = "none";
    },
    kind === "error" ? 7000 : 3000
  );
}

/* ================================================================== AI ==== */

const panel = new ChatPanel({
  onSend: (q) => void askQuestion(q),
  onStop: () => void chat.cancelActive(),
  onNewConversation: () => chat.newConversation(),
  onContextModeChange: (m) => chat.setContextMode(m),
  onOpenSettings: () => void settings.open(),
  onOpenLink: (url) => void openExternal(url),
  onCopy: (text) => void copyText(text),
});

const chat = new ChatController({
  startChat: (id, profileId, messages, onEvent, temperature, sessionId) =>
    bridge.aiStartChat(id, profileId, messages, onEvent, temperature, sessionId),
  cancelChat: (id) => bridge.aiCancelChat(id),
  onChange: () => renderChat(),
  newId: () => `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
});

const settings = new ProviderSettings({
  list: () => bridge.aiListProfiles(),
  presets: () => bridge.aiProviderPresets(),
  listModels: (baseUrl, profileId, sendSessionHeader) =>
    bridge.aiListModels(baseUrl, profileId, sendSessionHeader),
  save: (p) => bridge.aiSaveProfile(p),
  remove: (id, del) => bridge.aiDeleteProfile(id, del),
  setKey: (id, k) => bridge.aiSetKey(id, k),
  deleteKey: (id) => bridge.aiDeleteKey(id),
  test: (id, url, model) => bridge.aiTestConnection(id, url, model),
  onChanged: () => void refreshProfileState(),
});

const selectionBar = new SelectionBar(viewerWrap, {
  onHighlight: () => void doHighlight(),
  onExplain: () => void askWithPreset("explain"),
  onTranslate: () => void askWithPreset("translate"),
  onCopy: () => undefined, // the bar copies internally and reports failures
});

let activeProfileId: string | null = null;

async function refreshProfileState(): Promise<void> {
  try {
    const list = await bridge.aiListProfiles();
    if (!list.length) {
      activeProfileId = null;
      panel.setModelLabel("未配置");
      return;
    }
    // Keep the current choice if it still exists; otherwise take the default.
    const chosen =
      list.find((p) => p.id === activeProfileId) ??
      list.find((p) => p.is_default) ??
      list[0];
    activeProfileId = chosen.id;
    chat.setProfileId(chosen.id);
    panel.setModelLabel(`${chosen.display_name} · ${chosen.model}${chosen.has_key ? "" : " · 未配置 Key"}`);
  } catch (e) {
    diagnostics.log("warn", `refreshProfileState: ${String(e)}`);
  }
}

function renderChat(): void {
  const turns = chat.turns();
  const active = turns.find((t) => t.phase === "preparing" || t.phase === "streaming");
  panel.render(turns, active?.id ?? null);
  panel.setPhase(active?.phase ?? (turns.length ? lastPhase(turns) : "idle"), 0, turns.length);
  panel.setContextMode(chat.contextMode());
}

function lastPhase(turns: ReturnType<ChatController["turns"]>): ReturnType<ChatController["turns"]>[number]["phase"] {
  return turns[turns.length - 1]?.phase ?? "idle";
}

async function openExternal(url: string): Promise<void> {
  // Only ever reached from an explicit user click on a link that already
  // passed the https/http check in the renderer.
  try {
    if (bridge.isTauri) {
      const { open } = await import("@tauri-apps/plugin-dialog");
      void open;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  } catch {
    toast("无法打开链接", "warn");
  }
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast("已复制", "success");
  } catch {
    toast("复制失败（剪贴板不可用）", "warn");
  }
}

async function doHighlight(): Promise<void> {
  const n = await adapter.highlightSelection();
  if (n > 0) setDirty(true);
  else toast("请先在选择模式下选中一段文字", "warn");
}

/** Build the context and send. Shared by presets and free-form questions. */
async function sendWithMode(question: string, mode: ContextMode): Promise<void> {
  if (!activeProfileId) {
    panel.show();
    toast("请先在设置中配置 AI Provider", "warn");
    void settings.open();
    return;
  }
  if (chat.contextMode() !== mode) {
    chat.setContextMode(mode);
  }
  if (mode === "selection" && !isSnapshotCurrent(selection, currentDocumentId)) {
    toast("请先在 PDF 中选中一段文字", "warn");
    return;
  }

  const built = await buildContext({
    mode,
    question,
    selection: isSnapshotCurrent(selection, currentDocumentId) ? selection : null,
    getPageText: async (p) => adapter.getPageText(p),
    currentPage: adapter.currentPage,
    pageCount: adapter.numPages,
    documentTitle: currentName || "未命名文档",
    history: chat.history(),
  });

  if (mode === "current-page" || mode === "nearby-pages") {
    if (built.stats.chars <= question.length) {
      toast("当前页没有可提取的文字（可能是扫描页）", "warn");
      return;
    }
  }

  panel.show();
  renderChat();
  await chat.send({
    question,
    messages: built.messages,
    contextLabel: built.label,
    stats: built.stats,
  });
  renderChat();
}

async function askWithPreset(which: "explain" | "translate"): Promise<void> {
  // Read the selection NOW: the bar deliberately kept it alive, so this is the
  // freshest value and the reason the bar's pointerdown is prevented.
  selection = currentDocumentId
    ? captureSelection({ documentId: currentDocumentId })
    : null;

  if (!selection) {
    toast("选中文字后再点「解释」或「翻译」", "warn");
    return;
  }
  selectionBar.hide();
  await sendWithMode(PRESET_PROMPTS[which], "selection");
}

async function askQuestion(question: string): Promise<void> {
  await sendWithMode(question, chat.contextMode());
}

/* ============================================================== PDF open == */

/**
 * Run the recovery scan for a path the user is about to open.
 *
 * Read-only: it reports and asks; it never moves files on its own. Only a
 * confirmed choice is applied, and applying is idempotent.
 *
 * Returns false only when the user must not proceed (currently never — the
 * "decide later" path opens the document as-is).
 */
async function runRecoveryCheck(path: string): Promise<void> {
  if (!bridge.isTauri) return;
  try {
    const report = await bridge.scanRecovery(path);
    if (!report.needs_recovery && !report.candidates.some((c) => c.kind === "old")) {
      // Nothing to do; tidy stray temp files quietly, since they are ours.
      if (report.leftover_temps.length) {
        void bridge.applyRecovery(path, "clean_temps").catch(() => undefined);
      }
      return;
    }

    const choice = await bridge.askRecovery(report.summary);
    if (choice === "later") return;
    const res = await bridge.applyRecovery(path, choice === "restore" ? "restore_old" : "keep_new");
    toast(res.message, res.ok ? "success" : "error");
    if (res.displaced_to) {
      diagnostics.log("info", `recovery displaced previous content to ${res.displaced_to}`);
    }
  } catch (e) {
    // A failed scan must never block opening a document.
    diagnostics.log("warn", `recovery scan failed: ${String(e)}`);
  }
}

async function openPath(rawPath: string): Promise<boolean> {
  try {
    // Check for a crashed save before reading, so a missing/locked document
    // gets a chance to be restored rather than reported as "not found".
    await runRecoveryCheck(rawPath);
    const info = await bridge.invokeOpen(rawPath);
    const bytes = await bridge.readPdf(info.path);
    await adapter.open(bytes, info.name);
    currentPath = info.path;
    currentName = info.name;
    // A path-stable identity is enough to keep transcripts apart, and it is
    // never sent to a provider (only the display name is).
    currentDocumentId = info.path;
    chat.openDocument(currentDocumentId);
    selection = null;
    selectionBar.hide();
    statusFile.textContent = `${info.name} — ${adapter.numPages} 页`;
    adapter.markClean();
    toast(`已打开 ${info.name}`, "success");
    renderChat();
    return true;
  } catch (e) {
    diagnostics.log(
      "error",
      `openPath failed: ${String(e)} :: ${e instanceof Error ? e.stack : "no stack"}`
    );
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
  // Retire the outgoing document's AI session before switching.
  if (currentDocumentId) chat.closeDocument(currentDocumentId);
  await bridge.aiCancelAll().catch(() => 0);
  return await openPath(rawPath);
}

async function onOpenClicked() {
  const picked = await bridge.pickPdf();
  if (!picked) return;
  await guardedOpen(picked.path);
}

/* ============================================================== PDF save == */

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
  await saveTo(currentPath ?? null);
}
async function onSaveAs() {
  await saveTo(null);
}

/* ================================================================= tools == */

async function setTool(tool: ToolMode) {
  document.querySelectorAll(".tool").forEach((b) => b.classList.remove("active"));
  $(`#btn-${tool === "ink" ? "ink" : tool}`).classList.add("active");
  await adapter.setTool(tool);
  // The selection bar must not appear over drawing/erasing.
  if (tool !== "select") selectionBar.hide();
}

/* ================================================================ wiring == */

$("#btn-open").addEventListener("click", () => void onOpenClicked());
$("#btn-select").addEventListener("click", () => void setTool("select"));
$("#btn-highlight").addEventListener("click", () => void doHighlight());
$("#btn-ink").addEventListener("click", () => void setTool("ink"));
$("#btn-erase").addEventListener("click", async () => {
  // PDF.js only makes the editor layer hit-testable while an editing mode is
  // active, so selecting one of our own annotations requires entering a mode.
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

const aiToggle = $("#btn-ai");
if (aiToggle) {
  aiToggle.addEventListener("click", () => {
    panel.toggle();
    if (panel.isVisible()) {
      panel.focusInput();
      renderChat();
    }
  });
}

// Panel resize handle.
{
  const split = $("#main-split");
  split.appendChild(panel.root);
  const handle = document.createElement("div");
  handle.id = "ai-resizer";
  handle.title = "拖动调整宽度";
  split.insertBefore(handle, panel.root);
  let dragging = false;
  handle.addEventListener("pointerdown", (e) => {
    dragging = true;
    handle.classList.add("dragging");
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  });
  handle.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const rect = panel.root.getBoundingClientRect();
    const width = Math.max(280, Math.min(rect.right - e.clientX, window.innerWidth * 0.6));
    panel.root.style.setProperty("--ai-width", `${Math.round(width)}px`);
  });
  handle.addEventListener("pointerup", () => {
    dragging = false;
    handle.classList.remove("dragging");
  });
}

// NOTE: registered from boot(), AFTER adapter.init() — at module scope the
// EventBus does not exist yet and `.on` would throw, killing the module before
// the app is interactive.
function wireViewerEvents() {
  const bus = adapter.eventBusInstance;
  bus.on("pagechanging", (e: { pageNumber: number; pagesCount: number }) => {
    pageIndicator.textContent = `${e.pageNumber} / ${e.pagesCount}`;
  });
  bus.on("pagesinit", () => {
    pageIndicator.textContent = `1 / ${adapter.numPages}`;
    zoomLabel.textContent = `${Math.round(adapter.scale * 100)}%`;
  });
}

let raf = 0;
viewerContainer.addEventListener("mouseup", () => {
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(() => {
    const sel = window.getSelection();
    statusSel.textContent =
      sel && !sel.isCollapsed ? `选中: ${sel.toString().slice(0, 60)}` : "";
    const n = adapter.annotationCount();
    statusAnnot.textContent = `批注: ${n}`;
    if (n > 0) setDirty(true);
  });
});

window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    void onSave();
  }
  if (e.key === "Escape") {
    selectionBar.hide();
  }
});

/* ======================================================= single instance == */

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

/* ================================================================== boot == */

function reportFatal(where: string, err: unknown) {
  const msg = `ERR[${where}] ${String(err).slice(0, 160)}`;
  document.title = msg;
  if (!bridge.isTauri) return;
  void import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) => getCurrentWindow().setTitle(msg))
    .catch(() => undefined);
}

window.addEventListener("error", (e) => reportFatal("error", (e as ErrorEvent).message ?? e));
window.addEventListener("unhandledrejection", (e) =>
  reportFatal("rejection", (e as PromiseRejectionEvent).reason)
);

let disposeSelectionTracking: (() => void) | null = null;

async function boot() {
  await adapter.init();
  wireViewerEvents();

  // Browser fallback exists so the automated suite can run without Tauri. It is
  // a test affordance, not a product feature, so it is compiled in only for the
  // automation flavour (K-03) — `src-tauri` always provides the real picker.
  if (IS_AUTOMATION && !bridge.isTauri) installBrowserFileFallback();

  // Selection tracking: capture at pointerup/selectionchange, before any UI
  // reacts, so the floating bar can never lose the selection.
  disposeSelectionTracking = installSelectionTracking(
    viewerContainer,
    () => currentDocumentId,
    (snap) => {
      selection = snap;
      if (!snap) {
        selectionBar.hide();
        return;
      }
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        selectionBar.showAt(sel.getRangeAt(0).getBoundingClientRect(), snap.text.length > 0);
      }
    }
  );
  // While a drag is in progress the bar must stay out of the way.
  viewerContainer.addEventListener("pointerdown", () => selectionBar.setSuppressed(true));
  viewerContainer.addEventListener("pointerup", () => selectionBar.setSuppressed(false));

  if (bridge.isTauri) await refreshProfileState();

  await drainPendingFiles();
  if (!currentPath) statusFile.textContent = "未打开文件 — 点 Open 或拖入 PDF";
  renderChat();
  (window as unknown as Record<string, unknown>)[READY_FLAG] = true;
  console.log(
    `[PaperAI] ready — PDF.js ${PDFJS_VERSION}, tauri=${bridge.isTauri}, automation=${IS_AUTOMATION}`
  );
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
    currentDocumentId = `browser:${f.name}`;
    chat.openDocument(currentDocumentId);
    statusFile.textContent = `${f.name} — ${adapter.numPages} 页`;
    adapter.markClean();
  });
  (window as unknown as { __paperaiPickFile: () => void }).__paperaiPickFile = () => input.click();
}

boot().catch((e) => reportFatal("boot", e));
window.addEventListener("beforeunload", () => disposeSelectionTracking?.());

/* ============================================================ test bridge ==
 *
 * K-03: this surface must NOT exist in a released build. It is compiled in only
 * for `VITE_PAPERAI_AUTOMATION=1` (the `automation` build), and the release
 * build tree-shakes it away because the flag is statically false there.
 *
 * Rust-side fault injection has its own separate env gate
 * (`PAPERAI_ALLOW_FAULT_INJECTION`), so even an automation binary cannot inject
 * faults unless the operator opted in.
 */
if (IS_AUTOMATION) {
  Object.assign(window as unknown as Record<string, unknown>, {
    __paperai: {
      get version() {
        return PDFJS_VERSION;
      },
      get ready() {
        return !!(window as unknown as Record<string, unknown>)[READY_FLAG];
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
      get currentPage() {
        return adapter.currentPage;
      },
      getPageText: (p: number) => adapter.getPageText(p),
      pageHasText: (p: number) => adapter.pageHasText(p),
      open: (p: string) => openPath(p),
      openRaw: (p: string) => openPath(p),
      loadByArrayBuffer: async (buf: ArrayBuffer, name: string) => {
        await adapter.open(new Uint8Array(buf), name);
        currentName = name;
        currentPath = null;
        currentDocumentId = `buffer:${name}`;
        chat.openDocument(currentDocumentId);
        statusFile.textContent = `${name} — ${adapter.numPages} 页`;
        adapter.markClean();
      },
      loadByUrl: async (url: string, name: string) => {
        await adapter.open(url, name);
        currentName = name;
        currentDocumentId = `url:${name}`;
        chat.openDocument(currentDocumentId);
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
      saveRequest: (req: bridge.SaveRequest) => bridge.saveDocument(req),
      saveAsDialog: () => bridge.pickSaveTarget(currentName || "document.pdf"),
      /**
       * Text-layer spans matching `needle`, with viewport geometry.
       * Lives here (not on the adapter) so the release bundle does not contain
       * it at all — see K-03.
       */
      getSpanRects: (needle: string, limit = 8) => {
        const out: Array<{ text: string; x: number; y: number; w: number; h: number; page: number }> = [];
        viewerContainer.querySelectorAll<HTMLElement>(".page").forEach((pg) => {
          const pageNo = Number(pg.dataset.pageNumber ?? 0);
          pg.querySelectorAll<HTMLElement>(".textLayer span").forEach((s) => {
            if (out.length >= limit) return;
            if ((s.textContent ?? "").includes(needle)) {
              const b = s.getBoundingClientRect();
              out.push({
                text: (s.textContent ?? "").slice(0, 60),
                x: b.x,
                y: b.y,
                w: b.width,
                h: b.height,
                page: pageNo,
              });
            }
          });
        });
        return out;
      },
      __verifyLoaded: async () => {
        const bytes = await adapter.serialize();
        return adapter.verify(bytes);
      },
      /* ---- AI surface ---- */
      ai: {
        openPanel: () => {
          panel.show();
          renderChat();
        },
        hidePanel: () => panel.hide(),
        panelVisible: () => panel.isVisible(),
        openSettings: () => void settings.open(),
        hideSettings: () => settings.hide(),
        contextMode: () => chat.contextMode(),
        setContextMode: (m: ContextMode) => {
          chat.setContextMode(m);
          renderChat();
        },
        turns: () => chat.turns().map((t) => ({ ...t })),
        ask: (q: string) => askQuestion(q),
        explain: () => askWithPreset("explain"),
        translate: () => askWithPreset("translate"),
        stop: () => chat.cancelActive(),
        newConversation: () => chat.newConversation(),
        selection: () => (selection ? { ...selection } : null),
        refreshProfiles: () => refreshProfileState(),
        activeProfileId: () => activeProfileId,
        setActiveProfile: (id: string) => {
          activeProfileId = id;
          chat.setProfileId(id);
          return refreshProfileState();
        },
        humanError,
      },
    },
  });
}
