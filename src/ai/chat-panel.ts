/**
 * Right-hand AI chat panel.
 *
 * Rendering rule: during streaming the assistant turn is shown as **plain
 * text** (`textContent`), and only re-rendered as markdown+LaTeX once the turn
 * reaches a terminal state. Two reasons:
 *   - re-parsing markdown and re-running KaTeX on every token is far too
 *     expensive and janks the UI;
 *   - a half-finished `$...$` or ``` fence renders as garbage while typing.
 *
 * Scrolling rule: only the transcript scrolls, and only when the user is
 * already at the bottom. Nothing here touches the PDF's scroll position.
 */

import type {
  ChatPhase,
  ChatTurn,
  ContextMode,
  ImageAttachment,
  MemoryFile,
  ModelOption,
  ProfileStatus,
} from "./types";
import { formatTurnTime } from "./chat-history.js";
import { describeChars } from "./image-capture.js";
import { renderMarkdown } from "./markdown-renderer.js";
// The explicit `.js` is deliberate: Vite resolves either form, but the Node
// based unit suite imports this module's compiled output directly, and Node's
// ESM loader requires a real file extension. Do not "clean" it back.

export interface ChatPanelDeps {
  onSend: (question: string, attachments: ImageAttachment[]) => void;
  onStop: () => void;
  onNewConversation: () => void;
  onContextModeChange: (mode: ContextMode) => void;
  onOpenSettings: () => void;
  onOpenLink: (url: string) => void;
  onCopy: (text: string) => void;
  /** User picked a different provider; applies to the next send. */
  onSelectProfile: (profileId: string) => void;
  /** User picked a different model on the current provider. */
  onSelectModel: (profileId: string, model: string) => void;
  /** Build (or rebuild) this document's reading memory. */
  onGenerateMemory: () => void;
  /** Arm region selection over the PDF viewer. */
  onScreenshot: () => void;
  /**
   * Whether to carry earlier turns into the request.
   *
   * Turned off, the request is a clean slate: no history messages *and* no
   * remembered page images. The two must move together — see `setIncludeHistory`.
   */
  onIncludeHistory: (include: boolean) => void;
}

const MODE_LABELS: Record<ContextMode, string> = {
  none: "不发送文献内容",
  selection: "选中文字",
  "current-page": "当前页",
  "nearby-pages": "当前页±1",
  "whole-document": "整篇文章（文字）",
  "whole-document-images": "整篇文章（图片）",
};

const MODE_HINTS: Record<ContextMode, string> = {
  "none": "只发送你的问题与对话历史，不发送论文内容。",
  "selection": "发送你在 PDF 中选中的文字及其页码。",
  "current-page": "发送当前页的可提取文字。",
  "nearby-pages": "发送当前页、上一页与下一页的可提取文字。",
  "whole-document":
    "发送全篇的可提取文字（含页码标记），适合「概述全文」这类问题。论文很长时会超出长度上限，届时只发送前若干页，并会在回答和提示里标明实际范围。扫描件没有可提取文字，那种文档请用「整篇文章（图片）」。",
  "whole-document-images":
    "把每一页作为图像发送，适合扫描件——那种文档里根本没有文字可提取。代价是消耗远高于文字（每页约合上千 token），且受页数上限约束，超出的页不会发送并会明确告知。需要支持图片输入的模型。",
};

export class ChatPanel {
  readonly root: HTMLElement;
  private transcript: HTMLElement;
  private input: HTMLTextAreaElement;
  private sendBtn: HTMLButtonElement;
  private stopBtn: HTMLButtonElement;
  private modeSelect: HTMLSelectElement;
  private hintEl: HTMLElement;
  private profileSelect: HTMLSelectElement;
  private modelSelect: HTMLSelectElement;
  private statusEl: HTMLElement;
  private composerBar: HTMLElement;
  private memoryState!: HTMLElement;
  private memoryBtn!: HTMLButtonElement;
  /**
   * Screenshots waiting to go out with the next question.
   *
   * Held by the panel rather than by main so the chips and the send button see
   * the same list — an attachment the UI shows but the request drops is worse
   * than no attachment feature at all.
   */
  private attachments: ImageAttachment[] = [];
  /** The chip row, rebuilt whenever the attachment list changes. */
  private attachRow!: HTMLElement;
  /** Warning about the current model and images, when there is one. */
  private visionNote!: HTMLElement;
  /** Which turn is currently streamed as plain text. */
  private liveTurnId: string | null = null;
  /** Rendered turn nodes, keyed by turn id, reused while their content is unchanged. */
  private turnCache = new Map<string, { sig: string; node: HTMLElement }>();
  /** The "no questions yet" placeholder, so it is not rebuilt every render. */
  private emptyNote: HTMLElement | null = null;
  /** Ids of the turns currently in the DOM, in order — the in-place update key. */
  private renderedIds = "";
  /** Selectors are frozen while a request is in flight. */
  private busy = false;
  /** Provider whose model list is currently displayed. */
  private modelListOwner: string | null = null;
  /** A memory generation is running; the button must not be re-enterable. */
  private memoryBusy = false;
  /** Whether this document was found to have no extractable text. */
  private scanned = false;
  private historyToggle!: HTMLLabelElement;

  constructor(private deps: ChatPanelDeps) {
    this.root = document.createElement("aside");
    this.root.id = "ai-panel";
    this.root.hidden = true;

    // --- header
    const header = document.createElement("div");
    header.className = "ai-header";
    const title = document.createElement("div");
    title.className = "ai-title";
    title.textContent = "AI";
    // Provider + model pickers. This used to be a read-only text label, which
    // made the app look locked to whatever the default profile happened to be.
    this.profileSelect = document.createElement("select");
    this.profileSelect.id = "ai-profile-select";
    this.profileSelect.className = "ai-picker";
    this.profileSelect.title = "选择使用的 AI 服务商（对下一次提问生效）";
    this.profileSelect.addEventListener("change", () => {
      const id = this.profileSelect.value;
      if (id) this.deps.onSelectProfile(id);
    });
    this.modelSelect = document.createElement("select");
    this.modelSelect.id = "ai-model-select";
    this.modelSelect.className = "ai-picker";
    this.modelSelect.title = "选择使用的模型（对下一次提问生效）";
    this.modelSelect.addEventListener("change", () => {
      const model = this.modelSelect.value;
      const profileId = this.profileSelect.value;
      if (model && profileId) this.deps.onSelectModel(profileId, model);
    });
    const spacer = document.createElement("div");
    spacer.className = "ai-spacer";
    const newBtn = this.iconButton("新对话", "ai-new", () => this.deps.onNewConversation());
    const settingsBtn = this.iconButton("设置", "ai-settings-btn", () => this.deps.onOpenSettings());
    const closeBtn = this.iconButton("×", "ai-close", () => this.hide());
    header.append(title, this.profileSelect, this.modelSelect, spacer, newBtn, settingsBtn, closeBtn);

    // --- context selector
    const ctxRow = document.createElement("div");
    ctxRow.className = "ai-context";
    const ctxLabel = document.createElement("span");
    ctxLabel.textContent = "上下文";
    this.modeSelect = document.createElement("select");
    this.modeSelect.id = "ai-context-mode";
    for (const [mode, label] of Object.entries(MODE_LABELS)) {
      const o = document.createElement("option");
      o.value = mode;
      o.textContent = label;
      this.modeSelect.appendChild(o);
    }
    this.modeSelect.addEventListener("change", () => {
      const m = this.modeSelect.value as ContextMode;
      this.deps.onContextModeChange(m);
      this.hintEl.textContent = MODE_HINTS[m];
    });
    ctxRow.append(ctxLabel, this.modeSelect);

    // --- whether earlier turns travel with the question
    //
    // A checkbox rather than a mode, because it is orthogonal: "what part of the
    // paper" and "what came before" are separate questions, and a user asking a
    // follow-up about a figure needs both. On by default — that is what makes a
    // conversation a conversation — with an off switch for the case where the
    // earlier turns are steering the answer or costing more than they are worth.
    this.historyToggle = document.createElement("label");
    this.historyToggle.className = "ai-history-toggle";
    const historyBox = document.createElement("input");
    historyBox.type = "checkbox";
    historyBox.id = "ai-include-history";
    historyBox.checked = true;
    historyBox.addEventListener("change", () => {
      this.deps.onIncludeHistory(historyBox.checked);
      // Say what the switch actually changes: with history off, the model also
      // stops seeing previously sent page images, so a whole-document question
      // pays for them again.
      this.hintEl.textContent = historyBox.checked
        ? MODE_HINTS[this.modeSelect.value as ContextMode]
        : "不发送往期对话：本轮是全新上下文（之前发送过的页面图片也不会被模型看到，需要考虑重新发送）。";
    });
    const historyText = document.createElement("span");
    historyText.textContent = "含往期对话";
    this.historyToggle.append(historyBox, historyText);
    ctxRow.append(this.historyToggle);

    // --- reading memory
    // Long papers cannot fit in one request, so the app can keep notes about
    // this document in a file beside it and fold them back into later
    // questions. Deliberately a row of its own rather than a menu: whether
    // memory exists changes how every answer is produced, so the user should
    // see it without opening anything.
    const memRow = document.createElement("div");
    memRow.className = "ai-memory";
    const memLabel = document.createElement("span");
    memLabel.textContent = "阅读笔记";
    this.memoryState = document.createElement("span");
    this.memoryState.className = "ai-memory-state";
    this.memoryBtn = document.createElement("button");
    this.memoryBtn.type = "button";
    this.memoryBtn.id = "ai-memory-generate";
    this.memoryBtn.className = "ai-mini";
    this.memoryBtn.textContent = "生成";
    this.memoryBtn.title =
      "分块通读全文并生成笔记，保存为 PDF 同目录的 .paperai-notes.md。再次生成会覆盖。";
    this.memoryBtn.addEventListener("click", () => this.deps.onGenerateMemory());
    memRow.append(memLabel, this.memoryState, this.memoryBtn);

    this.hintEl = document.createElement("div");
    this.hintEl.className = "ai-hint";
    this.hintEl.textContent = MODE_HINTS.selection;

    // --- transcript
    this.transcript = document.createElement("div");
    this.transcript.className = "ai-transcript";
    this.transcript.id = "ai-transcript";

    // --- composer
    const composer = document.createElement("div");
    composer.className = "ai-composer";
    this.input = document.createElement("textarea");
    this.input.id = "ai-input";
    this.input.rows = 3;
    this.input.placeholder = "就这篇论文提问…（Enter 发送，Shift+Enter 换行）";
    this.input.addEventListener("keydown", (e) => {
      // An input method owns Enter while it is composing.
      //
      // Typing Chinese means every Enter is a composition key first — it commits
      // the highlighted candidate — and a send only second. Both are `"Enter"`,
      // so `key` cannot tell them apart, and treating a composition Enter as a
      // send breaks the question two ways at once: the candidate never lands in
      // the box, and a question goes out built from whatever half-finished
      // pinyin was in the field.
      //
      // The platform does distinguish them. `isComposing` is the standard signal;
      // `keyCode: 229` is what Windows input methods report, and either one alone
      // is enough. Both are honoured because getting this wrong is silent — the
      // question simply never appears — and one of the two is not universal.
      //
      // Shift+Enter is never a send, so it is not composition-sensitive.
      const imeOwnsIt = e.isComposing || e.keyCode === 229;
      if (e.key === "Enter" && !e.shiftKey && !imeOwnsIt) {
        e.preventDefault();
        this.submit();
      }
    });

    // Attachments live above the textarea, between it and the transcript, so
    // what is about to be sent is visible while the question is being typed.
    this.attachRow = document.createElement("div");
    this.attachRow.className = "ai-attach-row";
    this.attachRow.hidden = true;

    this.visionNote = document.createElement("div");
    this.visionNote.className = "ai-note ai-warn";
    this.visionNote.hidden = true;

    const shotBtn = this.iconButton("截图提问", "ai-shot", () => this.deps.onScreenshot());
    shotBtn.title = "在论文上框选一块区域，连同问题一起发送";

    this.composerBar = document.createElement("div");
    this.composerBar.className = "ai-composer-bar";
    this.statusEl = document.createElement("span");
    this.statusEl.className = "ai-status";
    this.sendBtn = document.createElement("button");
    this.sendBtn.type = "button";
    this.sendBtn.id = "ai-send";
    this.sendBtn.textContent = "发送";
    this.sendBtn.addEventListener("click", () => this.submit());
    this.stopBtn = document.createElement("button");
    this.stopBtn.type = "button";
    this.stopBtn.id = "ai-stop";
    this.stopBtn.textContent = "停止";
    this.stopBtn.className = "danger";
    this.stopBtn.hidden = true;
    this.stopBtn.addEventListener("click", () => this.deps.onStop());
    this.composerBar.append(shotBtn, this.statusEl, this.stopBtn, this.sendBtn);
    composer.append(this.input, this.attachRow, this.visionNote, this.composerBar);

    this.root.append(header, ctxRow, memRow, this.hintEl, this.transcript, composer);
  }

  private iconButton(label: string, id: string, fn: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.id = id;
    b.className = "ai-icon-btn";
    b.textContent = label;
    b.addEventListener("click", fn);
    return b;
  }

  private submit(): void {
    const q = this.input.value.trim();
    // An image with no words is a legitimate question — "what is in this
    // figure" — so attachments alone are enough to send.
    if (!q && this.attachments.length === 0) return;
    const attachments = this.attachments;
    this.input.value = "";
    this.attachments = [];
    this.renderAttachments();
    this.deps.onSend(q, attachments);
  }

  /** Add a captured screenshot to the pending list. */
  addAttachment(a: ImageAttachment): void {
    this.attachments.push(a);
    this.renderAttachments();
  }

  /** Drop one pending screenshot. */
  removeAttachment(id: string): void {
    this.attachments = this.attachments.filter((a) => a.id !== id);
    this.renderAttachments();
  }

  pendingAttachments(): ImageAttachment[] {
    return this.attachments.slice();
  }

  /**
   * Warn (or stop warning) that the current model may not accept images.
   *
   * The message comes from the provider's own refusal, recorded by
   * `vision-support`. Nothing here guesses: a model that has never refused an
   * image is never warned about.
   */
  setVisionWarning(message: string | null): void {
    if (!message) {
      this.visionNote.hidden = true;
      this.visionNote.textContent = "";
      return;
    }
    this.visionNote.hidden = false;
    this.visionNote.textContent =
      `当前模型可能不支持图片：${message}。可以换用支持视觉的模型，或移除截图后重试。`;
  }

  private renderAttachments(): void {
    const row = this.attachRow;
    row.replaceChildren();
    if (this.attachments.length === 0) {
      row.hidden = true;
      return;
    }
    row.hidden = false;
    for (const a of this.attachments) {
      const chip = document.createElement("span");
      chip.className = "ai-attach-chip";
      const img = document.createElement("img");
      img.src = a.url;
      img.alt = a.source === "page" ? `第 ${a.page ?? "?"} 页截图` : "选中区域截图";
      const label = document.createElement("span");
      label.className = "ai-attach-label";
      label.textContent =
        `${a.source === "page" ? "整页" : "区域"} · ${a.width}×${a.height} · ${describeChars(a.chars)}` +
        (a.page ? ` · 第 ${a.page} 页` : "");
      const del = document.createElement("button");
      del.type = "button";
      del.className = "ai-attach-del";
      del.textContent = "移除";
      del.title = "移除这张截图";
      del.addEventListener("click", () => this.removeAttachment(a.id));
      chip.append(img, label, del);
      row.append(chip);
    }
  }

  show(): void {
    this.root.hidden = false;
  }
  hide(): void {
    this.root.hidden = true;
  }
  isVisible(): boolean {
    return !this.root.hidden;
  }
  toggle(): void {
    this.root.hidden = !this.root.hidden;
  }

  focusInput(): void {
    this.input.focus();
  }
  setDraft(text: string): void {
    this.input.value = text;
    this.focusInput();
  }

  /**
   * Rebuild the provider picker.
   *
   * Each option carries the display name plus a marker when the key is missing:
   * "which service am I actually on" is the first question when a request fails,
   * and a bare `ai_unauthorized` in the transcript answers it far worse than the
   * header does.
   */
  setProviders(profiles: ProfileStatus[], activeId: string | null): void {
    this.profileSelect.textContent = "";
    if (!profiles.length) {
      const o = document.createElement("option");
      o.value = "";
      o.textContent = "未配置 Provider";
      this.profileSelect.appendChild(o);
      this.profileSelect.disabled = true;
      this.setModels(null, [], "");
      return;
    }
    for (const p of profiles) {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = p.has_key ? p.display_name : `${p.display_name} · 未配置 Key`;
      o.title = `${p.base_url}\n模型：${p.model}`;
      this.profileSelect.appendChild(o);
    }
    // Keep the caller's choice when it still exists; otherwise fall back to the
    // first entry. main.ts resolves the default, so this is only a safety net.
    const next = profiles.some((p) => p.id === activeId) ? (activeId as string) : profiles[0].id;
    this.profileSelect.value = next;
    if (this.modelListOwner !== next) {
      // The provider changed underneath us: show its saved model (marked as
      // current) until the caller hands us a live catalogue. Never render an
      // empty model box — that reads as "this provider has no models".
      this.setModels(next, null, profiles.find((p) => p.id === next)?.model ?? "");
    }
    this.profileSelect.disabled = this.busy;
  }

  /**
   * Show the model catalogue for `profileId`.
   *
   * `models === null` means "not fetched yet": the saved model is shown alone
   * behind a marker instead. `note` carries a loading/failure reason as a
   * disabled leading option. The saved model is always present even when the
   * live list disagrees — a model that is in use must never vanish from the UI.
   */
  setModels(
    profileId: string | null,
    models: ModelOption[] | null,
    savedModel: string,
    note?: string
  ): void {
    this.modelListOwner = profileId;
    this.modelSelect.textContent = "";
    this.modelSelect.title = "";
    if (profileId === null) {
      const o = document.createElement("option");
      o.value = "";
      o.textContent = "—";
      this.modelSelect.appendChild(o);
      this.modelSelect.disabled = true;
      return;
    }
    const seen = new Set<string>();
    const add = (id: string, hint?: string) => {
      if (!id || seen.has(id)) return;
      seen.add(id);
      const o = document.createElement("option");
      o.value = id;
      o.textContent = hint ? `${id}（${hint}）` : id;
      this.modelSelect.appendChild(o);
    };
    if (note) {
      const o = document.createElement("option");
      o.value = "";
      o.textContent = note;
      o.disabled = true;
      this.modelSelect.appendChild(o);
    }
    if (models === null) {
      if (savedModel) add(savedModel, "当前");
    } else {
      for (const m of models) {
        if (m.compatibility === "incompatible") continue;
        add(m.id, m.free_hint ? "可能免费" : undefined);
      }
      if (savedModel && !seen.has(savedModel)) add(savedModel, "当前（不在列表中）");
      if (!seen.size && savedModel) add(savedModel, "当前");
    }
    if (savedModel) this.modelSelect.value = savedModel;
    else if (seen.size) this.modelSelect.value = [...seen][0];
    this.modelSelect.disabled = this.busy;
  }

  /** Model list being fetched: show the reason inline instead of a stale list. */
  setModelListNote(profileId: string, note: string, savedModel: string): void {
    if (this.modelListOwner !== profileId) return;
    this.setModels(profileId, null, savedModel, note);
  }

  setContextMode(mode: ContextMode): void {
    this.modeSelect.value = mode;
    this.hintEl.textContent = MODE_HINTS[mode];
  }

  /**
   * Switch the mode from outside, and run the same path a user click would.
   *
   * Exists because there is one moment where the app knows better than the user
   * which mode to use: a document with no extractable text at all. Setting
   * `.value` alone would leave the hint showing the mode the user was just told
   * does not work, so this fires the change handler too.
   */
  selectMode(mode: ContextMode): void {
    if (this.modeSelect.value === mode) return;
    this.modeSelect.value = mode;
    this.deps.onContextModeChange(mode);
    this.hintEl.textContent = MODE_HINTS[mode];
  }

  /**
   * Replace the mode hint with a one-off message.
   *
   * Used when the mode's own description stops being the useful thing to say —
   * a scanned document in whole-document mode, where the mode hint still
   * promises "发送全篇的可提取文字" and there is none to send. Switching mode
   * restores the normal hint, so this is never sticky.
   */
  setHint(text: string): void {
    this.hintEl.textContent = text;
  }

  /**
   * Note that this document has no extractable text at all.
   *
   * Called when the app discovers it, which is the only moment it knows. The
   * memory line is the right place to say it: for a scanned paper, generating
   * notes is not a convenience — it is what makes later questions cost a few
   * hundred tokens instead of re-sending every page as an image. Without the
   * prompt the user pays full price on every question and has no way to learn
   * there was an alternative.
   */
  markScannedDocument(): void {
    this.scanned = true;
    if (!this.memoryState.textContent?.startsWith("已启用")) {
      this.memoryState.textContent = "扫描件 · 建议先生成笔记（后续提问不必重发图片）";
      this.memoryState.classList.add("on");
    }
    this.memoryBtn.textContent = "生成笔记";
    this.memoryBtn.title =
      "这份 PDF 没有可提取的文字，会按图片读取全文并生成笔记。生成后追问可直接用文字，不必每次重发整篇图片。";
  }

  /**
   * Show what reading memory this document has.
   *
   * The state line is the honest bit: whether the notes are being folded into
   * answers is something the user must be able to see, because it changes what
   * the model knows without the transcript mentioning it.
   */
  setMemoryState(memory: MemoryFile | null): void {
    this.memoryBusy = false;
    if (!memory) {
      // A scanned document keeps its own message: "无（超长文档可先生成）"
      // describes a long paper with text, which is a different situation with a
      // different reason to generate notes.
      this.memoryState.textContent = this.scanned
        ? "扫描件 · 建议先生成笔记（后续提问不必重发图片）"
        : "无（超长文档可先生成）";
      this.memoryState.classList.toggle("on", this.scanned);
      this.memoryBtn.textContent = this.scanned ? "生成笔记" : "生成";
      this.memoryBtn.disabled = false;
      return;
    }
    const bits = [`${(memory.bytes / 1024).toFixed(1)} KB`];
    if (memory.coveredPages) bits.push(memory.coveredPages);
    if (memory.updatedAt) bits.push(memory.updatedAt);
    this.memoryState.textContent = `已启用 · ${bits.join(" · ")}`;
    this.memoryState.classList.add("on");
    this.memoryState.title = memory.path;
    this.memoryBtn.textContent = "重新生成";
    this.memoryBtn.disabled = false;
  }

  /** Progress during a (potentially long) multi-request generation. */
  setMemoryBusy(busy: boolean, detail = ""): void {
    this.memoryBusy = busy;
    this.memoryBtn.disabled = busy;
    if (busy) {
      this.memoryState.classList.remove("on");
      this.memoryState.textContent = detail || "正在通读全文…";
      this.memoryBtn.textContent = "生成中…";
    } else {
      this.memoryBtn.textContent = "生成";
    }
  }

  /** True while a memory generation is in flight. */
  isMemoryBusy(): boolean {
    return this.memoryBusy;
  }

  /** Reflect the state machine in the composer. */
  setPhase(phase: ChatPhase, recordCount: number, messageCount: number): void {
    const busy = phase === "preparing" || phase === "streaming" || phase === "cancelling";
    // Switching provider/model mid-stream would not affect the in-flight
    // request, so it would silently lie about what is answering. Freeze both.
    if (busy !== this.busy) {
      this.busy = busy;
      this.profileSelect.disabled = busy || !this.profileSelect.options.length;
      this.modelSelect.disabled = busy || !this.modelSelect.options.length;
    }
    this.stopBtn.hidden = !busy || phase === "cancelling";
    this.sendBtn.disabled = busy;
    this.input.disabled = false; // typing is fine; send is what is gated
    switch (phase) {
      case "preparing":
        this.statusEl.textContent = "正在准备…";
        break;
      case "streaming":
        this.statusEl.textContent = "生成中…";
        break;
      case "cancelling":
        this.statusEl.textContent = "正在停止…";
        break;
      case "cancelled":
        this.statusEl.textContent = "已停止";
        break;
      default:
        this.statusEl.textContent = messageCount ? "" : "尚未提问";
    }
    void recordCount;
  }

  setStatus(text: string): void {
    this.statusEl.textContent = text;
  }

/**
 * Render the transcript.
 *
 * `liveId` is the turn currently streaming: it is drawn as plain text so we
 * do not re-parse markdown on every token.
 *
 * Finished turns are **reused, not rebuilt**. Measured in a real browser: the
 * naive "clear and rebuild everything" cost 62 ms per 200 tokens with no
 * history, 661 ms with 6 finished turns and 1773 ms with 20 — i.e. every token
 * re-ran KaTeX over the entire conversation. At 20 turns that is seconds of
 * blocked UI thread per answer, which is what made the composer look dead to
 * key presses while a reply streamed. Reusing each unchanged turn's DOM node
 * makes the per-token cost independent of history length.
 */
render(turns: ChatTurn[], liveId: string | null): void {
  this.liveTurnId = liveId;

  if (!turns.length) {
    if (this.emptyNote?.isConnected) return;
    this.transcript.textContent = "";
    this.turnCache.clear();
    this.renderedIds = "";
    const empty = document.createElement("div");
    empty.className = "ai-empty";
    empty.textContent = "在 PDF 中选中文字后点「解释」或「翻译」，或在下方直接提问。";
    this.transcript.appendChild(empty);
    this.emptyNote = empty;
    return;
  }
  if (this.emptyNote) {
    this.emptyNote.remove();
    this.emptyNote = null;
  }

  const atBottom =
    this.transcript.scrollTop + this.transcript.clientHeight >= this.transcript.scrollHeight - 24;

  const ids = turns.map((t) => t.id).join("|");

  if (ids === this.renderedIds && this.transcript.childElementCount === turns.length) {
    // Same turns in the same order: refresh only the ones that actually changed.
    // This is the per-token path, so it must not touch the others at all —
    // detaching and re-attaching every message re-invalidates layout and is
    // what made this O(history) per token.
    for (let i = 0; i < turns.length; i++) {
      const t = turns[i];
      const sig = turnSignature(t);
      const cached = this.turnCache.get(t.id);
      if (cached && cached.sig === sig) continue;
      const node = this.renderTurn(t);
      const old = cached?.node ?? this.transcript.children[i];
      if (old) this.transcript.replaceChild(node, old);
      else this.transcript.appendChild(node);
      this.turnCache.set(t.id, { sig, node });
    }
  } else {
    // Different set of turns: a full rebuild is the honest thing to do.
    const next = new Map<string, { sig: string; node: HTMLElement }>();
    const frag = document.createDocumentFragment();
    for (const t of turns) {
      const sig = turnSignature(t);
      const cached = this.turnCache.get(t.id);
      const node = cached && cached.sig === sig ? cached.node : this.renderTurn(t);
      next.set(t.id, { sig, node });
      frag.appendChild(node);
    }
    this.turnCache = next;
    this.transcript.textContent = "";
    this.transcript.appendChild(frag);
    this.renderedIds = ids;
  }

  // Only follow the stream when the user has not scrolled up to read.
  if (atBottom) this.transcript.scrollTop = this.transcript.scrollHeight;
}

  private renderTurn(t: ChatTurn): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = `ai-turn ai-turn-${t.role}`;
    wrap.dataset.turnId = t.id;

    const role = document.createElement("div");
    role.className = "ai-role";
    role.textContent = t.role === "user" ? "你" : "AI";
    // When it was said. Matters once conversations persist across sessions: a
    // restored transcript with no dates cannot be told from today's, and the
    // user has no way to know whether the paper's conclusions are older than
    // their memory of reading it.
    const when = formatTurnTime(t.createdAt);
    if (when) {
      const stamp = document.createElement("span");
      stamp.className = "ai-turn-time";
      stamp.textContent = when;
      stamp.title = "发送时间";
      role.appendChild(stamp);
    }
    if (t.contextLabel) {
      const ctx = document.createElement("span");
      ctx.className = "ai-turn-context";
      ctx.textContent = t.contextLabel;
      role.appendChild(ctx);
    }
    wrap.appendChild(role);

    const body = document.createElement("div");
    body.className = "ai-body";
    wrap.appendChild(body);

    // What the question was *about*. A question whose only subject is a figure
    // is unreadable later without the figure, so the thumbnails stay in the
    // transcript — and they are the same `data:` URLs that were sent, so what
    // is shown is exactly what the model saw.
    if (t.attachments?.length) {
      const strip = document.createElement("div");
      strip.className = "ai-turn-attachments";
      for (const a of t.attachments) {
        const img = document.createElement("img");
        img.src = a.url;
        img.alt = a.source === "page" ? `第 ${a.page ?? "?"} 页截图` : "选中区域截图";
        img.title = `${a.width}×${a.height} · ${describeChars(a.chars)}` +
          (a.page ? ` · 第 ${a.page} 页` : "");
        strip.appendChild(img);
      }
      wrap.appendChild(strip);
    }

    if (t.role === "assistant" && t.phase === "streaming" && t.id === this.liveTurnId) {
      // Plain text while streaming: cheap, and never half-parsed markup.
      body.classList.add("streaming");
      body.textContent = t.content;
      const caret = document.createElement("span");
      caret.className = "ai-caret";
      body.appendChild(caret);
    } else if (t.phase === "error") {
      // A-16: keep whatever arrived before the failure. A truncated answer is
      // still the model's work, and it is often the part the user needs in order
      // to judge whether retrying is worth it. Throwing it away and showing only
      // "timed out" makes a long, mostly-complete answer look like it produced
      // nothing at all.
      if (t.content) {
        const partial = document.createElement("div");
        partial.className = "ai-partial";
        try {
          renderMarkdown(partial, t.content, { onOpenLink: this.deps.onOpenLink });
        } catch {
          partial.textContent = t.content;
        }
        const note = document.createElement("div");
        note.className = "ai-note";
        note.textContent = "以上是中断前已生成的内容";
        body.append(partial, note);
      }
      body.appendChild(this.renderError(t));
    } else {
      // Final (or user) content is rendered as markdown.
      const md = document.createElement("div");
      body.appendChild(md);
      try {
        renderMarkdown(md, t.content, { onOpenLink: this.deps.onOpenLink });
      } catch {
        // Never let a renderer crash eat the answer.
        md.textContent = t.content;
      }
    }

    // Footer: copy + retry hints + cancellation note.
    const foot = document.createElement("div");
    foot.className = "ai-turn-foot";
    if (t.role === "assistant" && t.content && t.phase !== "error") {
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "ai-mini";
      copy.textContent = "复制";
      copy.addEventListener("click", () => this.deps.onCopy(t.content));
      foot.appendChild(copy);
    }
    if (t.phase === "cancelled") {
      const n = document.createElement("span");
      n.className = "ai-note";
      n.textContent = "已停止生成";
      foot.appendChild(n);
    }
    if (foot.childElementCount) wrap.appendChild(foot);

    return wrap;
  }

  private renderError(t: ChatTurn): HTMLElement {
    const box = document.createElement("div");
    box.className = "ai-error";

    const msg = document.createElement("div");
    msg.className = "ai-error-msg";
    msg.textContent = humanError(t.errorCode, t.errorMessage);
    box.appendChild(msg);

    const foot = document.createElement("div");
    foot.className = "ai-error-foot";
    foot.textContent = `错误码：${t.errorCode ?? "unknown"}`;
    box.appendChild(foot);

    const actions = document.createElement("div");
    actions.className = "ai-error-actions";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "ai-mini";
    copy.textContent = "复制错误";
    copy.addEventListener("click", () =>
      this.deps.onCopy(`${t.errorCode ?? "error"}: ${t.errorMessage ?? ""}`)
    );
    actions.appendChild(copy);
    if (t.errorCode === "ai_no_key" || t.errorCode === "ai_unauthorized") {
      const open = document.createElement("button");
      open.type = "button";
      open.className = "ai-mini primary";
      open.textContent = "打开设置";
      open.addEventListener("click", () => this.deps.onOpenSettings());
      actions.appendChild(open);
    }
    box.appendChild(actions);
    return box;
  }

  /** Scroll the transcript to the bottom on demand. */
  scrollToBottom(): void {
    this.transcript.scrollTop = this.transcript.scrollHeight;
  }
}

/**
 * Cheap identity for "has this turn changed since we rendered it?".
 *
 * Content length rather than the content itself: comparing thousands of
 * characters per turn on every token would defeat the point, and every way a
 * turn can change in place (streaming, then completed, then errored) alters at
 * least one of these fields.
 */
function turnSignature(t: ChatTurn): string {
  // Attachments are part of the turn's identity: a cached node without its
  // thumbnails is a question the user can no longer read.
  const att = (t.attachments ?? []).map((a) => `${a.id}:${a.chars}`).join(",");
  return `${t.phase}|${t.content.length}|${t.errorCode ?? ""}|${t.errorMessage ?? ""}|${t.contextLabel ?? ""}|${att}`;
}

/** Turn a backend error code into something a person can act on. */
export function humanError(code: string | undefined, raw: string | undefined): string {
  switch (code) {
    case "ai_no_key":
      return "尚未配置 API Key。请在设置中填写后再提问。";
    case "ai_no_profile":
      return "找不到该 Provider 配置，请在设置中重新添加。";
    case "ai_bad_config":
      return raw ?? "配置有误（Base URL 或模型名），请检查设置。";
    case "ai_insecure_refused":
      return raw ?? "拒绝向非本机地址使用明文 HTTP，请改用 https://。";
    case "ai_timeout":
      // Prefer the backend's wording: it knows whether the connection failed
      // outright or dropped mid-answer, and those need different advice. The
      // generic text is only the fallback.
      return raw ?? "连接超时。请检查网络、代理或 Base URL。";
    case "ai_first_token_timeout":
      return raw ?? "等待模型响应超时。可以重试，或换一个更小的上下文范围。";
    case "ai_unauthorized":
      return raw ?? "API Key 无效或没有权限。";
    case "ai_not_found":
      return raw ?? "接口或模型不存在，请检查 Base URL 与模型名。";
    case "ai_rate_limited":
      return "请求过于频繁或额度不足（429）。请稍后再试，本轮不会自动重试以免重复计费。";
    case "ai_provider_error":
      return raw ?? "模型服务返回错误，请稍后再试。";
    case "ai_network":
      return raw ?? "网络错误：无法连接到服务。";
    case "ai_bad_stream":
      return raw ?? "该服务没有返回 OpenAI 兼容的流式响应。";
    case "ai_cancelled":
      return "已取消。";
    case "ai_context_too_large":
      return "本次上下文超出上限，请缩小范围（例如改用「选中文字」或「当前页」）。";
    default:
      return raw ?? "发生未知错误。";
  }
}
