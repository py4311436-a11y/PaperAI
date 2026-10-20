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
import { eraseDecision } from "./tools/erase-policy";
import {
  buildContext,
  PAGE_IMAGE_MAX_EDGE,
  PRESET_PROMPTS,
} from "./ai/context-builder";
import {
  buildMemoryDocument,
  mergeMemoryBody,
  splitMemoryBody,
  chunkImagePrompt,
  chunkMessages,
  memoryContextBlock,
  mergePrompt,
  planChunks,
  planImageChunks,
  shouldRemember,
  type ChunkNote,
  type PageText,
} from "./ai/memory";
import { fromStoredChat, isTerminalPhase, type StoredChat } from "./ai/chat-history.js";
import type { ToolOutcome } from "./ai/chat-controller";
import type { ToolCall, ToolDef } from "./ai/types";
import { looksLikeTranslation } from "./ai/translation-intent";
import {
  MAX_REFETCH_PAGES,
  imageToolReply,
  planToolCalls,
  refusalReply,
} from "./ai/tool-calls";
import {
  captureSelection,
  installSelectionTracking,
  isSnapshotCurrent,
  type SelectionSnapshot,
} from "./ai/selection-snapshot";
import { captureRegion } from "./ai/image-capture";
import {
  ScreenshotOverlay,
  toCanvasRect,
  type ClientRect as ShotRect,
} from "./ai/screenshot-overlay";
import {
  imageFailureFor,
  looksLikeImageSupportError,
  noteImageFailure,
} from "./ai/vision-support";
import type {
  AiProfile,
  ChatMessage,
  ContextMode,
  ImageAttachment,
  MemoryFile,
  ModelOption,
  ProfileStatus,
} from "./ai/types";

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
  onSend: (q, attachments) => void askQuestion(q, attachments),
  onStop: () => void chat.cancelActive(),
  onNewConversation: () => chat.newConversation(),
  onContextModeChange: (m) => chat.setContextMode(m),
  onOpenSettings: () => void settings.open(),
  onOpenLink: (url) => void openExternal(url),
  onCopy: (text) => void copyText(text),
  onSelectProfile: (id) => void chooseProfile(id),
  onSelectModel: (profileId, model) => void chooseModel(profileId, model),
  onGenerateMemory: () => void generateMemory(),
  onScreenshot: () => armScreenshot(),
  onIncludeHistory: (include) => {
    includeHistory = include;
  },
  onSendBlocked: () => {
    // Name the reason. "回答还在生成中" is only half of it — the user's real
    // question in that moment is "is it stuck?", and with a seven-image request
    // it may genuinely take a minute or two before the first character appears.
    toast("正在等待上一个回答，请稍候；想打断就点「停止」", "warn");
    panel.show();
  },
});

const chat = new ChatController({
  startChat: (id, profileId, messages, onEvent, temperature, sessionId, tools) =>
    bridge.aiStartChat(id, profileId, messages, onEvent, temperature, sessionId, tools),
  cancelChat: (id) => bridge.aiCancelChat(id),
  // Read lazily: the choice is made before any document is open, and a session
  // created later must inherit it.
  currentProfileId: () => activeProfileId,
  log: (message) => bridge.uiLog(message),
  onChange: () => {
    renderChat();
    scheduleChatSave();
  },
  newId: () => `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
});

const settings = new ProviderSettings({
  list: () => bridge.aiListProfiles(),
  presets: () => bridge.aiProviderPresets(),
  listModels: (baseUrl, profileId) => bridge.aiListModels(baseUrl, profileId),
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

/* ============================================================ screenshots == */

/**
 * Region selection over the viewer.
 *
 * Mounted on `viewerWrap`, NOT on `viewerContainer`: the container scrolls, and
 * an `inset: 0` child of a scrolling box is positioned against the top of the
 * *content* — so it sails out of view the moment the user scrolls down.
 * `viewerWrap` is positioned and does not scroll, which makes the overlay cover
 * exactly what is on screen.
 *
 * One instance, reused across armings: it builds its DOM on `arm()` and tears
 * it down on the first selection or Escape, so there is never a second overlay
 * swallowing clicks after the user has moved on.
 */
const shotOverlay = new ScreenshotOverlay(viewerWrap, (rect) => {
  if (!rect) {
    toast("已取消截图", "info");
    return;
  }
  void captureSelectionRegion(rect);
});

/**
 * Turn a selection rectangle into an attachment.
 *
 * The region is mapped into the page canvas's own pixel coordinates — which is
 * where the zoom factor comes in. A page displayed at 50% has a canvas twice as
 * wide as its CSS box, and capturing without that scale returns the right area
 * at double size, i.e. half of what the user pointed at.
 */
async function captureSelectionRegion(rect: ShotRect): Promise<void> {
  const page = adapter.currentPage;
  const canvas = pageCanvas(page);
  if (!canvas) {
    toast("当前页还没有渲染出来，请稍候再试", "warn");
    return;
  }
  // `rect` is already in client coordinates, so the canvas's own client box is
  // the only reference needed.
  const box = canvas.getBoundingClientRect();
  const scale = canvas.width / Math.max(1, box.width);
  const region = toCanvasRect(rect, box.left, box.top, scale);

  try {
    const shot = await captureRegion(canvas, region);
    // The page's text layer holds the words inside the selection, exactly.
    // Reading them costs nothing and needs no OCR; a scanned page has no text
    // layer, and then the image is all there is.
    const text = await adapter.getRegionText(page, region, canvas.width);
    panel.addAttachment({
      id: `shot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      url: shot.url,
      chars: shot.chars,
      width: shot.width,
      height: shot.height,
      source: "region",
      page,
      text: text || undefined,
    });
    panel.show();
    toast(
      text
        ? `已截取 ${shot.width}×${shot.height}，并提取到 ${text.length} 字（可切换为「用文字」）`
        : `已截取 ${shot.width}×${shot.height}，写在问题里一起发送`,
      "success"
    );
  } catch (e) {
    toast(e instanceof Error ? e.message : "截图失败", "warn");
  }
}

/** The rendered canvas of a page, or null before it has painted. */
function pageCanvas(page: number): HTMLCanvasElement | null {
  const pg = viewerContainer.querySelector<HTMLElement>(`.page[data-page-number="${page}"]`);
  return pg?.querySelector<HTMLCanvasElement>("canvas") ?? null;
}

/**
 * Arm region selection.
 *
 * Refuses without an open document rather than arming an overlay over an empty
 * viewer — the user would drag a rectangle around nothing and only learn
 * afterwards.
 */
function armScreenshot(): void {
  if (!adapter.numPages) {
    toast("请先打开一篇 PDF", "warn");
    return;
  }
  shotOverlay.arm();
  panel.show();
  toast("在论文上拖选一块区域；Esc 取消", "info");
}

/**
 * Refresh the image-support warning for the current model.
 *
 * Driven by what the provider has actually said, never by a guess: a model that
 * has never refused an image is never warned about.
 */
function refreshVisionWarning(): void {
  const profile = cachedProfiles.find((p) => p.id === activeProfileId);
  const model = profile?.model?.trim();
  panel.setVisionWarning(model ? imageFailureFor(model) : null);
}

let activeProfileId: string | null = null;

/** The profile currently selected, or undefined before settings have loaded. */
function activeProfile(): ProfileStatus | undefined {
  return cachedProfiles.find((p) => p.id === activeProfileId);
}
/**
 * The open document's reading memory, if it has one.
 *
 * Kept in memory as well as on disk so a follow-up question does not re-read
 * the file, and so the panel can show the state without awaiting anything.
 */
let currentMemory: MemoryFile | null = null;
/** True while the multi-request memory pipeline is running. */
let memoryBusy = false;

/** Load the sidecar for a freshly opened document. Never throws. */
async function loadMemory(pdfPath: string): Promise<void> {
  try {
    currentMemory = await bridge.aiMemoryRead(pdfPath);
  } catch (e) {
    // A foreign file in the way is worth saying out loud, but it is not a
    // reason to refuse to open the paper.
    currentMemory = null;
    diagnostics.log("warn", `loadMemory: ${String(e)}`);
  }
  panel.setMemoryState(currentMemory);
}

/**
 * Whether earlier turns travel with the question.
 *
 * One flag for two things that must never disagree: the history messages and the
 * set of pages the model is assumed to already hold. Sending history without the
 * page list means re-sending images the model already has; sending the page list
 * without history means skipping images the model *cannot* see — the page
 * vanishes from the document and nothing in the answer reveals it.
 */
let includeHistory = true;

/** The block injected into the next question, or null when there is none. */
function memoryContext(): string | null {
  if (!currentMemory?.content?.trim()) return null;
  return memoryContextBlock(currentMemory);
}

/**
 * Restore a document's saved conversation.
 *
 * Failure is logged and swallowed. A conversation that cannot be read is a loss
 * of convenience; refusing to open the paper over it would be a loss of the
 * thing the user actually came for.
 */
async function loadChatHistory(pdfPath: string): Promise<void> {
  try {
    const doc = await bridge.aiChatRead(pdfPath);
    const turns = fromStoredChat(doc);
    if (!turns.length) return;
    chat.restoreTurns(turns);
    renderChat();
    toast(`已恢复 ${turns.filter((t) => t.role === "user").length} 轮历史对话`, "info");
  } catch (e) {
    diagnostics.log("warn", `loadChatHistory: ${String(e)}`);
  }
}

/**
 * Persist the conversation.
 *
 * Fire-and-forget by design: a failed save must not interrupt reading, and the
 * in-memory conversation is still intact. The next turn tries again with the
 * full session, so a transient failure self-heals — which is why this writes a
 * snapshot of everything rather than appending one turn.
 */
let chatSaveChain: Promise<void> = Promise.resolve();
let chatSaveTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Save the conversation, but only once the newest answer has stopped changing.
 *
 * `onChange` fires on every streamed delta — hundreds of times per answer — and
 * each save rewrites the whole JSON. The guard is the phase, not a timer alone:
 * a debounce that fired mid-stream would store a truncated answer, which reads
 * later as the model having trailed off for no reason.
 */
/**
 * The two note tools, offered together.
 *
 * The distinction the reader cares about is *append* versus *regenerate*, and
 * the wording carries it: 「更新笔记」/「记到笔记里」 appends, 「重新生成笔记」 rebuilds
 * the summary. The descriptions are the only place that mapping is written down,
 * so they are written carefully — a model picks a tool by its description.
 *
 * `append_note` is cheap (one file write). `refresh_notes` re-reads the whole
 * document, so it is expensive and the app confirms it before running.
 */
function noteTools(): ToolDef[] {
  return [
    {
      type: "function",
      function: {
        name: "append_note",
        description:
          "把一条内容追加到本文档的「阅读笔记」末尾，不影响已有内容。" +
          "当用户说「更新笔记」「记到笔记里」「把这段记下来」「加上这一条」时使用。" +
          "text 写成一条独立、可读的笔记（不要带上「好的」这类对话语气）。",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string", description: "要追加的笔记内容" },
          },
          required: ["text"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "refresh_notes",
        description:
          "重新通读全文并重新生成「阅读笔记」的概要部分（会覆盖现有概要，但保留问答记录）。" +
          "只有当用户明确要求「重新生成笔记」「重新生成阅读笔记」「重建笔记」时才使用；" +
          "仅仅想记录一条内容时请用 append_note。这个操作会重新处理全文，代价较高，" +
          "应用会先向用户确认。",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    },
  ];
}

/**
 * The one tool the app offers: read a page of the open document.
 *
 * Deliberately narrow. It takes one page number and returns that page's image;
 * it cannot read the filesystem, call a URL, or return more than the viewer is
 * already showing. A tool is an action the model can take, so the set of actions
 * has to be small enough to reason about — and the name is checked again in Rust
 * against its own allowlist.
 */
function readPageTool(pageCount: number): ToolDef {
  return {
    type: "function",
    function: {
      name: "read_page",
      description:
        `读取当前论文某一页的图像。只有在笔记或已提供的内容不足以回答时才调用；` +
        `一次只取一页，需要多页就分多次调用。本文档共 ${pageCount} 页。`,
      parameters: {
        type: "object",
        properties: {
          page: {
            type: "integer",
            description: `页码，从 1 开始，最大 ${pageCount}`,
            minimum: 1,
            maximum: pageCount,
          },
        },
        required: ["page"],
        additionalProperties: false,
      },
    },
  };
}

/**
 * Fulfil the model's page requests.
 *
 * Every decision here is a refusal or a cap, because this is the one place a
 * model can make the app do something:
 *
 *  - only `read_page` is honoured; anything else is refused by name
 *  - the page must be an integer inside the document, or it is refused rather
 *    than clamped — a clamp would hand back the wrong page and the model would
 *    answer from it
 *  - at most `MAX_REFETCH_PAGES` distinct pages per question
 *  - beyond that the user is asked, and a "no" ends the turn with a reason
 *
 * Refusals go back to the model as a `tool` message rather than as an error: it
 * can then answer from what it has, which is better than the user getting
 * nothing because the model asked for something impossible.
 */
/**
 * Reject instead of waiting forever.
 *
 * A promise with no timeout is unbounded, and an unbounded settle inside the tool
 * loop leaves the turn at "生成中…" with no request in flight and nothing in the
 * log — which is exactly what a refetch stall looked like. The renderer is the
 * step that touches the document, so it is the one that can wait on something
 * outside this file.
 */
function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label}超时（${Math.round(ms / 1000)} 秒）`)), ms)
    ),
  ]);
}

/** How long one page render may take before the refetch is abandoned. */
const REFETCH_RENDER_TIMEOUT_MS = 20_000;

/**
 * Fulfil the two note tools.
 *
 * `append_note` writes one line into the log; `refresh_notes` re-reads the whole
 * document, so it is confirmed first and then run in the background — the model
 * must not be made to wait minutes for a pipeline it only asked to start, and
 * the turn must not be held open for it.
 *
 * Returns the messages to continue the conversation with. The model's next
 * words are its own, so the wording of these replies matters: it has to be able
 * to say truthfully "已追加" or "已开始重新生成" rather than "已完成".
 */
async function fulfilNoteTool(
  call: ToolCall,
  pageCount: number
): Promise<{ messages: ChatMessage[]; stop?: string }> {
  const id = call.id;
  const name = call.function?.name ?? "";

  if (name === "append_note") {
    let text = "";
    try {
      text = String(JSON.parse(call.function?.arguments || "{}")?.text ?? "").trim();
    } catch {
      text = String(call.function?.arguments ?? "").trim();
    }
    if (!text) {
      return {
        messages: [
          refusalReply(id, '没有提供要追加的内容。请用 {"text": "..."} 重新调用。'),
        ],
      };
    }
    try {
      const heading = `追加 · ${new Date().toLocaleString("zh-CN", { hour12: false })}`;
      currentMemory = await bridge.aiMemoryAppend(currentPath ?? "", heading, text);
      panel.setMemoryState(currentMemory);
      bridge.uiLog(`append_note: ${text.slice(0, 60)}`);
      return {
        messages: [
          {
            role: "tool",
            tool_call_id: id,
            content: "已追加到阅读笔记末尾。",
          },
        ],
      };
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      bridge.uiLog(`append_note failed: ${why}`);
      return { messages: [refusalReply(id, `追加失败：${why}`)] };
    }
  }

  if (name === "refresh_notes") {
    const ok = window.confirm(
      `重新生成阅读笔记需要重新处理全文（约 ${Math.max(1, Math.ceil(pageCount / 2))} 次请求）。\n\n` +
        `现有概要会被覆盖；问答记录会保留。\n\n是否继续？`
    );
    if (!ok) {
      return {
        messages: [
          refusalReply(id, "用户没有确认，已取消重新生成。"),
        ],
        stop: "（用户取消了重新生成笔记。）",
      };
    }
    if (memoryBusy) {
      return { messages: [refusalReply(id, "笔记正在生成中，请稍候再试。")] };
    }
    // Started, not finished: the model must not claim it is done.
    // `allowWhileChatBusy`: the call comes from inside a live turn, and the
    // notes pipeline does not share any state with the chat.
    void generateMemory({ allowWhileChatBusy: true });
    bridge.uiLog("refresh_notes: started in background");
    return {
      messages: [
        {
          role: "tool",
          tool_call_id: id,
          content: "已开始重新生成笔记，正在后台处理全文。完成后会更新「阅读笔记」。",
        },
      ],
    };
  }

  return { messages: [refusalReply(id, `不支持的工具：${name}。`)] };
}

async function fulfilToolCalls(
  calls: ToolCall[],
  pageCount: number,
  alreadyFetched: Set<number>,
  alreadyInRequest: ReadonlySet<number>
): Promise<ToolOutcome> {
  // Every rule about *what may be fetched* lives in `planToolCalls`, which is
  // pure and tested. This function only does the parts that need the app: a
  // confirmation, a render, a progress line.
  const replies: ChatMessage[] = [];

  // The note tools are not page fetches, so they are handled before the page
  // plan: their rules are entirely different and they must not consume the
  // refetch budget.
  const noteCalls = calls.filter(
    (c) => c.function?.name === "append_note" || c.function?.name === "refresh_notes"
  );
  if (noteCalls.length) {
    let stopped: string | undefined;
    for (const call of noteCalls) {
      const outcome = await fulfilNoteTool(call, pageCount);
      // Into the same list as the page replies: a model may ask for a note and
      // a page in one turn, and every id must be answered exactly once.
      replies.push(...outcome.messages);
      if (outcome.stop) stopped = outcome.stop;
    }
    if (stopped) {
      return { kind: "stop", reason: stopped };
    }
    // If the model asked for a note and a page, both are honoured.
    const pageCalls = calls.filter(
      (c) => c.function?.name !== "append_note" && c.function?.name !== "refresh_notes"
    );
    if (!pageCalls.length) {
      return { kind: "continue", messages: replies };
    }
    calls = pageCalls;
  }

  const plan = planToolCalls(calls, pageCount, alreadyFetched, alreadyInRequest);
  bridge.uiLog(
    `tool calls: n=${calls.length} fetch=[${plan.fetch.join(",")}] ` +
      `refused=${plan.replies.length} overBudget=${plan.overBudget} ` +
      `already=${alreadyFetched.size} inRequest=${alreadyInRequest.size}`
  );
  for (const r of plan.replies) replies.push(refusalReply(r.id, r.reason));

  if (!plan.fetch.length) {
    return { kind: "continue", messages: replies };
  }

  let approved = plan.fresh;
  if (plan.overBudget) {
    const list = plan.fresh.join("、");
    const ok = window.confirm(
      `模型想读取第 ${list} 页的图像以回答这个问题。` +
        `本次已自动读取 ${alreadyFetched.size} 页，超过 ${MAX_REFETCH_PAGES} 页上限。\n\n` +
        `同意继续发送吗？（这会再消耗一部分额度）`
    );
    if (!ok) {
      return {
        kind: "stop",
        reason:
          `模型需要第 ${list} 页的图像才能回答，但本次自动补发已达上限` +
          `（${MAX_REFETCH_PAGES} 页），已停止以免继续消耗额度。` +
          `可以缩小问题范围，或改用能提供更多页的上下文模式。`,
      };
    }
    approved = plan.fresh;
  }

  for (const page of approved) {
    alreadyFetched.add(page);
    panel.setPhase("preparing", 0, chat.turns().length, approved.length);
    bridge.uiLog(`refetch: rendering page ${page}`);
    let shot: Awaited<ReturnType<typeof adapter.renderPageImage>>;
    try {
      shot = await withTimeout(
        adapter.renderPageImage(page, PAGE_IMAGE_MAX_EDGE),
        REFETCH_RENDER_TIMEOUT_MS,
        `渲染第 ${page} 页`
      );
    } catch (e) {
      // A page that cannot be rendered must not take the answer with it: reply
      // with the failure so the model can say what it could not read.
      const why = e instanceof Error ? e.message : String(e);
      bridge.uiLog(`refetch: page ${page} failed: ${why}`);
      replies.push(
        refusalReply(
          calls.find((c) => c.function?.name === "read_page")?.id ?? `call_${page}`,
          `第 ${page} 页的图像无法取回（${why}）。请用已有内容回答，并说明缺什么。`
        )
      );
      continue;
    }
    bridge.uiLog(`refetch: page ${page} ok chars=${shot.chars}`);
    pendingRefetchAttachments.push({
      id: `refetch-${page}-${Date.now().toString(36)}`,
      url: shot.url,
      chars: shot.chars,
      width: shot.width,
      height: shot.height,
      source: "page",
      page,
    });
    const call = calls.find((c) => {
      if (c.function?.name !== "read_page") return false;
      try {
        return JSON.parse(c.function.arguments || "{}")?.page === page;
      } catch {
        return false;
      }
    });
    replies.push(imageToolReply(call?.id ?? `call_${page}`, page, shot.url));
    toast(`正在查看第 ${page} 页…`, "info");
  }

  // Every id needs exactly one reply or the request is malformed. The plan
  // already replies to refusals; this covers a page that was planned but not
  // approved.
  for (const call of calls) {
    if (!replies.some((r) => (r as { tool_call_id?: string }).tool_call_id === call.id)) {
      replies.push(
        refusalReply(call.id, "这一页本次没有重新发送。请用已有内容回答，并说明缺什么。")
      );
    }
  }

  return { kind: "continue", messages: replies };
}

/** Images pulled in by refetches during the current question. */
const pendingRefetchAttachments: ImageAttachment[] = [];
/**
 * Pages already refetched for the current question.
 *
 * Reset at the start of each question, and counted in pages rather than rounds:
 * a model that asks for page 5 twice must not get two free pages.
 */
const refetchedPages = new Set<number>();
/**
 * Pages this question's context already carries.
 *
 * Filled from the built context right before sending. Separate from
 * `refetchedPages` because the two answer different questions: this one is
 * "would fetching it again be waste?", the other is "may I spend more?".
 */
const sentPagesThisTurn = new Set<number>();

/**
 * Whether the last question was about the whole document.
 *
 * Recorded at send time rather than inferred later from a label string: the
 * label is presentation, and rebuilding a control decision out of it is how the
 * two drift apart.
 */
let lastSendWasWholeDocument = false;
/** Documents we have already tried to note-ify, so a failure is not retried in a loop. */
const notesAutoTried = new Set<string>();

/**
 * Generate reading notes after the first whole-document answer.
 *
 * The trade this makes: the first question already uploaded the entire document,
 * so the notes cost one more pass and are then worth many — every later question
 * drops from thousands of tokens of page images to a few hundred of text. Doing
 * it on the first question rather than asking the user to find a button is the
 * difference between the feature being used and being ignored.
 *
 * Guards, in order of why they matter:
 *  - notes already exist: never overwrite work the user may have edited
 *  - already tried for this document: a failure must not become a retry loop
 *    that spends tokens every time a question is asked
 *  - something else is running: the notes pipeline would be refused mid-flight
 *
 * Stated plainly to the user, because this spends their tokens without being
 * asked. The memory row shows the progress.
 */
function maybeAutoNotes(): void {
  if (!currentPath || !activeProfileId) return;
  if (!lastSendWasWholeDocument) return;
  if (currentMemory?.content?.trim()) return;
  if (memoryBusy || chat.isBusy()) return;
  const key = currentDocumentId ?? currentPath;
  if (notesAutoTried.has(key)) return;
  if (!adapter.numPages) return;

  notesAutoTried.add(key);
  toast("正在自动生成阅读笔记，之后提问不必再重发全文（可在「阅读笔记」处查看进度）", "info");
  void generateMemory();
}

function scheduleChatSave(): void {
  const last = chat.turns().at(-1);
  if (!last || last.role !== "assistant" || !isTerminalPhase(last.phase)) return;
  if (chatSaveTimer !== null) clearTimeout(chatSaveTimer);
  // Snapshot now, not when the timer fires. Between the two the user can send
  // another question, and a snapshot taken then would contain a turn that is
  // still running — which comes back on the next open as an active turn and
  // disables sending with nothing in flight. The check above and the snapshot
  // have to describe the same moment.
  // An answer just finished. If it was a whole-document question, the document
  // is already in the model's hands — the cheapest possible moment to note-ify.
  maybeAutoNotes();
  const doc = chat.snapshotForStorage(currentName || "未命名文档");
  chatSaveTimer = setTimeout(() => {
    chatSaveTimer = null;
    saveChatHistory(doc);
  }, 400);
}

function saveChatHistory(doc: StoredChat): void {
  if (!currentPath) return;
  const path = currentPath;
  if (!doc.turns.length) return;
  // Serialised so two rapid turns cannot interleave their writes and leave the
  // file holding neither.
  chatSaveChain = chatSaveChain
    .then(async () => {
      await bridge.aiChatWrite(path, doc);
    })
    .catch((e) => {
      diagnostics.log("warn", `saveChatHistory: ${String(e)}`);
    });
}
let cachedProfiles: ProfileStatus[] = [];
/**
 * Live catalogues, keyed by profile id. A catalogue is a network round trip and
 * provider lists change weekly, so one fetch per provider per app run is the
 * right trade; the settings dialog still offers an explicit refresh.
 */
const modelCatalogues = new Map<string, { baseUrl: string; models: ModelOption[] }>();
/** Guards against a slow fetch for an abandoned provider overwriting the UI. */
let modelFetchToken = 0;

function savedModelOf(profileId: string): string {
  return cachedProfiles.find((p) => p.id === profileId)?.model ?? "";
}

function describeErr(e: unknown): string {
  if (typeof e === "string") return e;
  if (typeof e === "object" && e && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}

/**
 * Paint the model list for a provider, fetching it at most once.
 *
 * The saved model always survives into the list: if the live catalogue disagrees
 * with what is in use, the in-use model stays visible (marked) instead of being
 * replaced by a list that does not contain it.
 */
async function loadModels(p: ProfileStatus): Promise<void> {
  const token = ++modelFetchToken;
  const cached = modelCatalogues.get(p.id);
  if (cached && cached.baseUrl === p.base_url) {
    panel.setModels(p.id, cached.models, savedModelOf(p.id));
    return;
  }
  panel.setModelListNote(p.id, "正在拉取模型列表…", savedModelOf(p.id));
  try {
    const models = await bridge.aiListModels(p.base_url, p.id);
    if (token !== modelFetchToken || activeProfileId !== p.id) return;
    modelCatalogues.set(p.id, { baseUrl: p.base_url, models });
    panel.setModels(p.id, models, savedModelOf(p.id));
  } catch (e) {
    if (token !== modelFetchToken || activeProfileId !== p.id) return;
    const msg = describeErr(e);
    diagnostics.log("warn", `loadModels(${p.id}): ${msg}`);
    panel.setModelListNote(p.id, `拉取失败：${msg}`, savedModelOf(p.id));
  }
}

/** User picked a different provider from the panel header. */
async function chooseProfile(id: string): Promise<void> {
  if (id === activeProfileId) return;
  const p = cachedProfiles.find((x) => x.id === id);
  if (!p) return;
  activeProfileId = id;
  chat.setProfileId(id);
  panel.setProviders(cachedProfiles, id);
  refreshVisionWarning();
  await loadModels(p);
}

/**
 * User picked a different model from the panel header.
 *
 * Persisted to the profile, not kept in memory: the request path reads the model
 * from the saved profile, so an in-memory choice would silently revert on the
 * next launch.
 */
async function chooseModel(profileId: string, model: string): Promise<void> {
  const p = cachedProfiles.find((x) => x.id === profileId);
  if (!p || p.model === model) return;
  const profile: AiProfile = {
    id: p.id,
    display_name: p.display_name,
    base_url: p.base_url,
    model,
    credential_id: p.id,
    is_default: p.is_default,
    sends_session_header: p.sends_session_header,
  };
  try {
    const saved = await bridge.aiSaveProfile(profile);
    Object.assign(p, saved);
    panel.setModels(profileId, modelCatalogues.get(profileId)?.models ?? null, model);
    refreshVisionWarning();
    diagnostics.log("info", `model switched: profile=${profileId} model=${model}`);
  } catch (e) {
    const msg = describeErr(e);
    diagnostics.log("warn", `chooseModel(${profileId}): ${msg}`);
    // Snap the picker back to what is actually saved, so the header cannot
    // claim a model the next request will not use.
    panel.setModels(profileId, modelCatalogues.get(profileId)?.models ?? null, p.model, `切换失败：${msg}`);
    toast(`切换模型失败：${msg}`, "error");
  }
}

async function refreshProfileState(): Promise<void> {
  try {
    const list = await bridge.aiListProfiles();
    cachedProfiles = list;
    if (!list.length) {
      activeProfileId = null;
      panel.setProviders(list, null);
      return;
    }
    // Keep the current choice if it still exists; otherwise take the default.
    const chosen =
      list.find((p) => p.id === activeProfileId) ??
      list.find((p) => p.is_default) ??
      list[0];
    activeProfileId = chosen.id;
    chat.setProfileId(chosen.id);
    panel.setProviders(list, chosen.id);
    refreshVisionWarning();
    void loadModels(chosen);
  } catch (e) {
    diagnostics.log("warn", `refreshProfileState: ${String(e)}`);
  }
}

/**
 * Open the per-document conversation and bind it to the active provider.
 *
 * Two reasons this is one call and not two at each site. A session created while
 * a provider is already selected inherits it (`currentProfileId`), but one
 * created *before* the provider was configured starts unbound — and nothing else
 * re-binds it, so the first send is refused for a reason the user cannot see.
 * And there are four places a document gets opened; missing the extra line at
 * any of them recreates exactly that bug.
 */
function openChatSession(documentId: string): void {
  chat.openDocument(documentId);
  if (activeProfileId) chat.setProfileId(activeProfileId);
}

function renderChat(): void {
  const turns = chat.turns();
  const activeAt = turns.findIndex((t) => t.phase === "preparing" || t.phase === "streaming");
  const active = activeAt >= 0 ? turns[activeAt] : undefined;
  panel.render(turns, active?.id ?? null);
  // How many images the in-flight question carried. A seven-page request
  // legitimately takes a minute or two before the first character arrives, and
  // "正在准备…" for that long is indistinguishable from a hang — so the status
  // line says what is actually being waited on.
  const pending = activeAt > 0 ? (turns[activeAt - 1].attachments?.length ?? 0) : 0;
  panel.setPhase(
    active?.phase ?? (turns.length ? lastPhase(turns) : "idle"),
    0,
    turns.length,
    pending
  );
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
  // Enter highlight mode FIRST, unconditionally, so the button lights up and
  // the user can drag over text straight away. This used to run only when a
  // selection already existed, which is why the button could not be pressed on
  // its own: it was an action, not a mode.
  await setTool("highlight");
  const made = await adapter.highlightSelection();
  if (made > 0) {
    setDirty(true);
  } else {
    // Not a warning: the mode is now armed, this is what to do next.
    toast("已进入高亮模式：在 PDF 中拖选文字即可高亮", "info");
  }
}

/**
 * Build the context and send. Shared by presets and free-form questions.
 *
 * @param remember Whether this exchange belongs in the document's reading
 *   memory. False for exactly one case — a translation — because a translation
 *   is a verbatim restatement of the paper: it adds no understanding, and the
 *   memory file is capped at 2 MiB with oldest-first trimming, so every
 *   translation entry crowds out an entry that was actually insight. Everything
 *   else — an opinion about the paper, the explanation that finally made a
 *   method section make sense — is what the memory is for.
 */
async function sendWithMode(
  question: string,
  mode: ContextMode,
  attachments: ImageAttachment[] = [],
  remember = true,
): Promise<void> {
  lastSendWasWholeDocument = mode === "whole-document" || mode === "whole-document-images";
  // Fresh budget for this question. Without the reset the cap would be
  // per-session and the second question would be refused forever.
  refetchedPages.clear();
  pendingRefetchAttachments.length = 0;
  sentPagesThisTurn.clear();
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
    // Rasterised straight from the document, never from a painted canvas — see
    // `renderPageImage`. This is the path that makes a scanned paper askable.
    getPageImage: async (p) => {
      const shot = await adapter.renderPageImage(p, PAGE_IMAGE_MAX_EDGE);
      return {
        id: `page-${p}-${Date.now().toString(36)}`,
        url: shot.url,
        chars: shot.chars,
        width: shot.width,
        height: shot.height,
        source: "page",
        page: p,
      };
    },
    // Pages the model can already see from earlier turns, so they are not
    // rendered and sent a second time. Derived from the same window the history
    // uses — see `pagesInHistory` on the controller for why that matters.
    pagesInHistory: includeHistory ? chat.pagesInHistory() : [],
    currentPage: adapter.currentPage,
    pageCount: adapter.numPages,
    documentTitle: currentName || "未命名文档",
    history: includeHistory ? chat.history() : [],
    // Belt and braces: the flag decides both, so a caller that passes an
    // explicit limit still cannot get history messages the page list did not
    // account for.
    historyLimit: includeHistory ? 6 : 0,
    // Reading memory is passed in so it lands in the stable prefix with the
    // document, not appended after the history where nothing can be cached.
    memory: currentMemory,
    // Whole-document mode prefers the notes when they exist. That is the whole
    // economy of a scanned paper: ~800 tokens per question against ~3150 for
    // re-sending seven page images. Without notes the builder falls back to the
    // document text, and then to the image mode's own path.
    useNotesAsDocument: mode === "whole-document" && !!currentMemory?.content?.trim(),
    // Screenshots ride with the question, never with the document — see
    // composeQuestionTurn. An image in the document message would make the
    // prefix diverge on every question and cost the cache the whole time.
    attachments,
  });

  // What this request already carries. A read_page for one of these pages is a
  // duplicate the model does not need to pay for.
  for (const page of built.stats.pages_sent) sentPagesThisTurn.add(page);

  if (mode === "current-page" || mode === "nearby-pages") {
    if (built.stats.chars <= question.length) {
      toast("当前页没有可提取的文字（可能是扫描页）", "warn");
      return;
    }
  }

  // A document with no extractable text anywhere — a scanned paper, an
  // image-only export. This is a real condition, not the old render-state bug:
  // `getPageText` now reads the document itself, so an empty result means the
  // text genuinely is not there.
  //
  // Sending anyway is the worst of the options. The request goes out with the
  // question and nothing else, the model can only answer "you have not given me
  // the paper", and the user pays for a round trip to be told the app already
  // knew. There is also something to do about it — the image mode sends each
  // page as a picture, which works exactly where text extraction does not — so
  // offer that instead of failing quietly.
  //
  // The mode is switched for the user rather than merely named. They asked a
  // question about a paper and got told the paper cannot be read; the next thing
  // they want is to ask it again, not to go hunting for a setting.
  // `document_chars`, not `pages_sent`: a notes-based request carries the paper
  // as text and has no pages, so keying on pages made a perfectly good request
  // look like a blank scan and blocked it. That is the exact shape of the bug
  // this line had.
  if (mode === "whole-document" && built.stats.document_chars === 0) {
    toast("这篇文档没有可提取的文字（扫描件），已停止发送", "warn");
    // Record it so the memory row can offer the thing that actually makes this
    // document cheap to keep asking about.
    panel.markScannedDocument();
    panel.setHint(
      "全文无可提取文字——这是扫描件，文字管线对图片页无能为力。" +
        "已为你切换到「整篇图片」模式，直接再问一次即可：每页会作为图像发送，视觉模型可以读图。" +
        "（若只想问某块区域，也可继续用「截图提问」。）"
    );
    panel.selectMode("whole-document-images");
    // Put the question back. `submit()` cleared the box before calling here, so
    // without this the refusal silently eats what the user typed — and the next
    // thing they must do is type it again from memory.
    if (question) panel.setDraft(question);
    return;
  }

  // Reading memory goes in as prior context, folded into the document message
  // ahead of the history — see composeContextTurn for why it is not a second
  // `system` message and why it must sit in the stable prefix.
  const messages = built.messages;

  panel.show();
  renderChat();
  const turnId = await chat.send({
    question,
    messages,
    contextLabel: memoryContext() ? `${built.label} · 含阅读笔记` : built.label,
    stats: built.stats,
    attachments,
    // The active provider's per-image charge, when it publishes one, so the
    // transcript can show what the images cost instead of just how many there
    // were. Undefined for providers that price by image content — the display
    // then says the cost is theirs rather than inventing a number.
    imageTokens: activeProfile()?.image_tokens,
    // Offered only when the answer could actually benefit: with no document
    // open there is no page to read, and offering the tool would invite a call
    // that can only be refused.
    // The page tool only makes sense with a document open; the note tools do
    // too (they write a file next to it), so all three come together.
    tools: adapter.numPages
      ? [readPageTool(adapter.numPages), ...noteTools()]
      : undefined,
    onToolCalls: async (calls) => {
      // Pages the context mode already sent are in the request, so asking for
      // one again is a duplicate — but it must not consume the refetch budget.
      // Seeding `refetchedPages` with them would do exactly that: a seven-page
      // image question would start out over budget and every call would prompt.
      const outcome = await fulfilToolCalls(
        calls,
        adapter.numPages,
        refetchedPages,
        sentPagesThisTurn
      );
      return outcome;
    },
  });
  renderChat();
  // Pages pulled in during the answer are part of what the question was
  // answered from, so the transcript has to show them — otherwise a later read
  // of the conversation cannot tell why the answer mentions a figure the
  // question never included.
  if (pendingRefetchAttachments.length) {
    chat.attachToLastUserTurn(pendingRefetchAttachments.slice());
    pendingRefetchAttachments.length = 0;
    renderChat();
  }
  // A null turn id means the controller refused. Say *which* thing is wrong:
  // the earlier version inferred "busy" whenever any turn existed, so a session
  // with no provider set reported "上一个回答仍在进行中" — a confident, wrong
  // diagnosis that sent the user looking for a stop button that did nothing.
  if (!turnId) {
    const why = !activeProfileId
      ? "尚未选择 AI Provider，请在设置中配置"
      : chat.isBusy()
        ? "上一个回答仍在进行中，请稍候或点「停止」"
        : !chat.profileId()
          ? "当前会话未绑定 Provider，请重新选择模型"
          : "会话尚未就绪，请重新打开文档后再试";
    diagnostics.log("warn", `send refused: ${why}`);
    toast(`未发送：${why}`, "warn");
  }

  // Learn from a refusal.
  //
  // An image question that failed with something reading like "this model does
  // not support images" is recorded against the model, so the *next* attempt is
  // warned before it is sent instead of after. There is no way to know in
  // advance which models take images — a catalogue returns ids and nothing
  // else — so this is the only source of truth that cannot go stale or lie.
  // A model that works is never warned about.
  const last = chat.turns().at(-1);
  if (turnId && attachments.length && last?.role === "assistant" && last.phase === "error") {
    const raw = last.errorMessage ?? "";
    if (looksLikeImageSupportError(raw)) {
      const model = cachedProfiles.find((p) => p.id === activeProfileId)?.model ?? "";
      if (model) {
        noteImageFailure(model, raw);
        refreshVisionWarning();
      }
    }
  }

  // Keep the exchange in the document's reading memory.
  //
  // Everything is kept except a translation — see `sendWithMode`'s `remember`
  // parameter for why that one is excluded. Previously only `whole-document`
  // qualified, which meant an opinion about the paper, or the explanation that
  // finally made a method section make sense, was forgotten the moment the
  // panel closed, and the next session started from nothing.
  if (turnId && remember) {
    void appendMemoryFromTurn(question, turnId);
  }
}

/**
 * Append a finished exchange to the reading memory.
 *
 * Best effort and silent on failure: the answer is already on screen, and a
 * write problem (read-only folder, sync conflict, foreign file in the way)
 * must not turn a good answer into an error state.
 *
 * The safety of the write itself is Rust's job, not this function's: the marker
 * check that refuses to touch a file we did not write, the 2 MiB cap, and the
 * oldest-first trimming all live in `ai/memory.rs`. Nothing here can bypass
 * them, which is why a bad write fails quietly instead of corrupting a file.
 */
async function appendMemoryFromTurn(question: string, turnId: string): Promise<void> {
  if (!currentPath) return;
  try {
    const answer = chat.turns().find((t) => t.id === turnId)?.content ?? "";
    if (!answer.trim()) return;
    const when = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    const heading = `${when.getFullYear()}-${p(when.getMonth() + 1)}-${p(when.getDate())} ${p(when.getHours())}:${p(when.getMinutes())} · ${question.slice(0, 24)}`;
    // A digest, not the whole answer: the memory file is context for later
    // questions, and a full transcript would crowd out the notes.
    const entry = `**问：** ${question}\n\n**答：** ${answer.slice(0, 1200).trim()}`;
    currentMemory = await bridge.aiMemoryAppend(currentPath, heading, entry);
    panel.setMemoryState(currentMemory);
  } catch (e) {
    diagnostics.log("warn", `appendMemoryFromTurn: ${String(e)}`);
  }
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
  // An explanation is understanding and belongs in the memory. A translation is
  // a restatement of the paper and does not — see `shouldRemember`.
  await sendWithMode(PRESET_PROMPTS[which], "selection", [], shouldRemember(which));
}

async function askQuestion(
  question: string,
  attachments: ImageAttachment[] = []
): Promise<void> {
  // A translation request wants the *words*, and the page's text layer has them
  // exactly — so the text is sent instead of the image. The reader can see which
  // is in use on the chip and switch it back.
  //
  // Only for screenshots that actually have text: a scanned region has none,
  // and there the image is the only source.
  if (attachments.length && looksLikeTranslation(question)) {
    let switched = 0;
    for (const a of attachments) {
      if (a.source === "region" && a.text?.trim() && !a.preferText) {
        a.preferText = true;
        switched++;
      }
    }
    if (switched) {
      panel.refreshAttachments();
      toast(`这是翻译请求，已改用提取到的文字（点截图上的「用文字」可切回图片）`, "info");
    }
  }
  await sendWithMode(question, chat.contextMode(), attachments);
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
    openChatSession(currentDocumentId);
    selection = null;
    selectionBar.hide();
    statusFile.textContent = `${info.name} — ${adapter.numPages} 页`;
    adapter.markClean();
    toast(`已打开 ${info.name}`, "success");
    renderChat();
    // Reading memory is loaded after the document so the panel can show its
    // state immediately; a failure here must never block opening the PDF.
    void loadMemory(info.path);
    // Same rule for the conversation: a corrupt or missing history must not
    // stop the paper from opening. It is the user's reading, not ours.
    void loadChatHistory(info.path);
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

/**
 * Read the whole paper in chunks and write the notes beside the PDF.
 *
 * This is the fallback for a document too long for one request. It is
 * deliberately sequential: chunks are sent one at a time, so peak memory and
 * rate-limit pressure stay flat, and a failure half-way leaves the previously
 * saved notes untouched (nothing is written until every chunk has answered).
 *
 * Cost is real — one request per chunk plus a merge — so it is user-initiated.
 */
/**
 * Regenerate the reading notes.
 *
 * `allowWhileChatBusy` exists because the model can now ask for this from
 * inside a conversation — and at that moment the chat *is* busy, so the usual
 * guard would refuse the very call that was just requested.
 *
 * It is safe: the notes pipeline runs its own one-shot requests and never
 * touches the chat session, so the two do not compete for the chat's state.
 * Only `memoryBusy` still blocks it — two notes pipelines at once would fight
 * over the same file.
 */
async function generateMemory(opts: { allowWhileChatBusy?: boolean } = {}): Promise<void> {
  if (!currentPath) {
    toast("未打开文档", "warn");
    return;
  }
  if (!activeProfileId) {
    toast("请先在设置中配置 AI Provider", "warn");
    void settings.open();
    return;
  }
  if ((!opts.allowWhileChatBusy && chat.isBusy()) || memoryBusy) {
    toast("请等待当前操作完成", "warn");
    return;
  }

  memoryBusy = true;
  panel.setMemoryBusy(true);
  const total = adapter.numPages;
  try {
    // Collect the pages first; the chunker needs them all to plan boundaries.
    const all: PageText[] = [];
    for (let p = 1; p <= total; p++) {
      const text = await adapter.getPageText(p);
      all.push({ page: p, text: text ?? "" });
      if (p % 20 === 0) {
        panel.setMemoryBusy(true, `正在读取第 ${p}/${total} 页…`);
      }
    }

    const chunks = planChunks(all);
    if (!chunks.length) {
      // No extractable text anywhere: a scanned paper. The text path cannot
      // help, but the notes are most valuable exactly here — they are what lets
      // later questions be text-only instead of re-sending every page image.
      // So fall back to reading the pages as images, same output contract, so
      // the merge pass and the sidecar format are unchanged.
      await generateMemoryFromImages(total, currentName || "未命名文档");
      return;
    }

    const notes: ChunkNote[] = [];
    for (const [i, chunk] of chunks.entries()) {
      panel.setMemoryBusy(true, `正在生成笔记 ${i + 1}/${chunks.length}（第 ${chunk.from}–${chunk.to} 页）…`);
      const text = await askOnce(chunkMessages(chunk, total));
      if (!text.trim()) {
        toast(`第 ${chunk.from}–${chunk.to} 页没有得到内容，已停止（未覆盖原有笔记）`, "error");
        return;
      }
      notes.push({ from: chunk.from, to: chunk.to, note: text });
    }

    panel.setMemoryBusy(true, "正在合并全文概要…");
    const overview = await askOnce([
      {
        role: "user",
        content: mergePrompt(notes, total),
      },
    ]);

    const profile = cachedProfiles.find((p) => p.id === activeProfileId);
    const body = buildMemoryDocument({
      docTitle: currentName || "未命名文档",
      model: profile?.model ?? "未知模型",
      totalPages: total,
      notes,
      overview,
      now: new Date(),
    });
    // Regenerating replaces the summary, but the log of what the reader asked
    // and what they were told is theirs, not ours to delete. Split the old file
    // and put the log back underneath the new summary.
    const preserved = splitMemoryBody(currentMemory?.content ?? "");
    const merged = mergeMemoryBody(body, preserved.qa);
    currentMemory = await bridge.aiMemoryWrite(currentPath, merged);
    panel.setMemoryState(currentMemory);
    toast(
      `阅读笔记已保存：${chunks.length} 段 · ${currentMemory.path}`,
      "success"
    );
  } catch (e) {
    const msg = String(e);
    diagnostics.log("error", `generateMemory: ${msg}`);
    toast(`生成阅读笔记失败：${msg}`, "error");
  } finally {
    memoryBusy = false;
    panel.setMemoryBusy(false);
  }
}

/**
 * Generate reading notes for a document with no extractable text.
 *
 * This is the payoff for a scanned paper: the notes are what make later
 * questions cheap. Once they exist, a question can use the text path against
 * the notes instead of re-sending every page image — a few hundred tokens
 * against ~2.7k for seven pages.
 *
 * It costs the images once. That is the trade, and it is why this only runs
 * when the user asks for it rather than automatically on open.
 *
 * Runs from the caller's try/finally so the busy flag is reset in one place.
 */
async function generateMemoryFromImages(total: number, title: string): Promise<void> {
  const chunks = planImageChunks(total);
  const notes: ChunkNote[] = [];

  for (const [i, chunk] of chunks.entries()) {
    panel.setMemoryBusy(
      true,
      `正在读图生成笔记 ${i + 1}/${chunks.length}（第 ${chunk.from}–${chunk.to} 页）…`
    );

    // Rendered from the document, not from painted canvases — a page the user
    // has not scrolled to still has to be readable here.
    const urls: string[] = [];
    for (let p = chunk.from; p <= chunk.to; p++) {
      const shot = await adapter.renderPageImage(p, PAGE_IMAGE_MAX_EDGE);
      urls.push(shot.url);
    }

    const text = await askOnce([
      {
        role: "user",
        content: [
          { type: "text", text: chunkImagePrompt(chunk.from, chunk.to, total) },
          ...urls.map((url) => ({ type: "image_url" as const, image_url: { url } })),
        ],
      },
    ]);
    if (!text.trim()) {
      toast(
        `第 ${chunk.from}–${chunk.to} 页没有得到内容，已停止（未覆盖原有笔记）`,
        "error"
      );
      return;
    }
    notes.push({ from: chunk.from, to: chunk.to, note: text });
  }

  panel.setMemoryBusy(true, "正在合并全文概要…");
  const overview = await askOnce([{ role: "user", content: mergePrompt(notes, total) }]);

  const profile = activeProfile();
  const body = buildMemoryDocument({
    docTitle: title,
    model: profile?.model ?? "未知模型",
    totalPages: total,
    notes,
    overview,
    now: new Date(),
  });
  if (!currentPath) return;
  currentMemory = await bridge.aiMemoryWrite(currentPath, body);
  panel.setMemoryState(currentMemory);
  toast(
    `阅读笔记已保存（按图片读取）：${chunks.length} 段 · ${currentMemory.path}`,
    "success"
  );
}

/**
 * One complete answer, no streaming.
 *
 * Used by the memory pipeline, which needs finished text before it can store
 * anything. It still goes through the normal streaming provider underneath —
 * only the presentation differs — so there is one request path, one SSE parser
 * and one set of timeout rules to reason about.
 */
async function askOnce(messages: ChatMessage[]): Promise<string> {
  if (!activeProfileId) throw new Error("未配置 AI Provider");
  return await bridge.aiAskOnce(activeProfileId, messages);
}

/**
 * The toolbar indicator, driven from ONE place.
 *
 * Every bug here was the same bug: the lit button was written somewhere else
 * (or not at all), so it described a mode the app was not in.
 *   - Highlight ran `doHighlight()` and never touched the indicator, so the
 *     user stayed looking at a lit "Select" while the editor was in HIGHLIGHT.
 *   - Erase had no `tool` class at all, so it could never be lit.
 *   - Erase armed itself by entering ink mode, which lit **Draw** — pressing
 *     Erase appeared to light a different tool, i.e. a dead button.
 *
 * `erase` is not a `ToolMode`: PDF.js has no eraser editor, deleting requires
 * an annotation to be selected. It is a user-facing *action* that borrows ink
 * mode only so the annotation layer becomes hit-testable, which is why it is
 * tracked separately here and lit on its own button.
 */
type ToolbarState = "select" | "highlight" | "ink" | "erase";
let toolbarState: ToolbarState = "select";
/** True while the eraser is waiting for a click on an annotation. */
let eraseArmed = false;

function setToolbarState(next: ToolbarState): void {
  toolbarState = next;
  if (next !== "erase") eraseArmed = false;
  document.querySelectorAll(".tool").forEach((b) => b.classList.remove("active", "armed"));
  const btn = $(`#btn-${next}`);
  btn.classList.add("active");
  // "armed" is the extra signal that erase is waiting for you to click an
  // annotation, as opposed to Select/Draw/Highlight which act immediately.
  if (next === "erase") btn.classList.add("armed");
}

async function setTool(tool: ToolMode) {
  setToolbarState(tool);
  await adapter.setTool(tool);
  // The selection bar must not appear over drawing/erasing.
  if (tool !== "select") selectionBar.hide();
}

/** Leave the armed-erase state without touching the document. */
function exitEraseArmed(): void {
  if (!eraseArmed) return;
  eraseArmed = false;
  void setTool("select");
}

/* ================================================================ wiring == */

$("#btn-open").addEventListener("click", () => void onOpenClicked());
$("#btn-select").addEventListener("click", () => void setTool("select"));
$("#btn-highlight").addEventListener("click", () => void doHighlight());
$("#btn-ink").addEventListener("click", () => void setTool("ink"));
$("#btn-erase").addEventListener("click", async () => {
  // Arming deletes NOTHING. The old code checked for a selection here and
  // deleted immediately — and because PDF.js keeps a freshly drawn ink editor
  // selected, pressing Erase after drawing removed that stroke. The user read
  // that as "it erases my last action" rather than "it erases what I click".
  //
  // Ink mode is entered only so the annotation layer becomes hit-testable (PDF.js
  // has no eraser editor); the toolbar lights ERASE, never Draw.
  await adapter.setTool("ink");
  eraseArmed = true;
  setToolbarState("erase");
  selectionBar.hide();
  toast("擦除模式：点击要删除的批注（Esc 或点 Select 退出）", "info");
});

/**
 * "Click where you want it gone".
 *
 * PDF.js owns the hit testing: a click on an editor selects it. We only decide
 * whether that click is allowed to delete, and we require the pointer to have
 * landed on an annotation — see `tools/erase-policy.ts` for why that matters.
 *
 * The delete is deferred by one frame because PDF.js applies the selection in
 * its own pointer handling, which can run after this listener.
 */
viewerWrap.addEventListener(
  "pointerdown",
  (e) => {
    if (!eraseArmed) return;
    const hit = adapter.isPointOnAnnotation(e.clientX, e.clientY);
    requestAnimationFrame(() => {
      const decision = eraseDecision({
        armed: eraseArmed,
        hitAnnotation: hit,
        hasSelection: !!adapter.debugState().hasSelection,
      });
      if (decision !== "delete") return;
      if (adapter.deleteSelected()) {
        setDirty(true);
        // Stay armed: removing several annotations in a row is the common case.
        setToolbarState("erase");
      }
    });
  },
  true
);
document.addEventListener("keydown", (e) => {
  // Escape is the conventional "cancel what I armed" key, and armed-erase is
  // the one toolbar state that waits for a further click.
  if (e.key === "Escape") exitEraseArmed();
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

// The toolbar entry for the screenshot question. The chat composer has one
// too; this one exists because the action is about *where you are looking* —
// the question occurs to the user while they are reading a figure, and the
// toolbar is where they already are. Both arm the same overlay.
$("#btn-shot").addEventListener("click", () => armScreenshot());

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
    openChatSession(currentDocumentId);
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
      /** Which toolbar button is lit, and whether the eraser is armed. */
      get toolbar() {
        return { state: toolbarState, eraseArmed };
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
      pageHasText: (p: number) => adapter.pageHasText(p),      open: (p: string) => openPath(p),
      openRaw: (p: string) => openPath(p),
      loadByArrayBuffer: async (buf: ArrayBuffer, name: string) => {
        await adapter.open(new Uint8Array(buf), name);
        currentName = name;
        currentPath = null;
        currentDocumentId = `buffer:${name}`;
        openChatSession(currentDocumentId);
        statusFile.textContent = `${name} — ${adapter.numPages} 页`;
        adapter.markClean();
      },
      loadByUrl: async (url: string, name: string) => {
        await adapter.open(url, name);
        currentName = name;
        currentDocumentId = `url:${name}`;
        openChatSession(currentDocumentId);
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
