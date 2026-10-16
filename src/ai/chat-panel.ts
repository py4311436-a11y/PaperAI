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
  MemoryFile,
  ModelOption,
  ProfileStatus,
} from "./types";
import { renderMarkdown } from "./markdown-renderer.js";
// The explicit `.js` is deliberate: Vite resolves either form, but the Node
// based unit suite imports this module's compiled output directly, and Node's
// ESM loader requires a real file extension. Do not "clean" it back.

export interface ChatPanelDeps {
  onSend: (question: string) => void;
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
}

const MODE_LABELS: Record<ContextMode, string> = {
  "none": "不发送文献",
  "selection": "选中文字",
  "current-page": "当前页",
  "nearby-pages": "相邻三页",
  "whole-document": "整篇文章",
};

const MODE_HINTS: Record<ContextMode, string> = {
  "none": "只发送你的问题与对话历史，不发送论文内容。",
  "selection": "发送你在 PDF 中选中的文字及其页码。",
  "current-page": "发送当前页的可提取文字。",
  "nearby-pages": "发送当前页、上一页与下一页的可提取文字。",
  "whole-document":
    "发送全篇的可提取文字（含页码标记），适合「概述全文」这类问题。论文很长时会超出长度上限，届时只发送前若干页，并会在回答和提示里标明实际范围。",
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
  /** Which turn is currently streamed as plain text. */
  private liveTurnId: string | null = null;
  private lastRenderedSignature = "";
  /** Selectors are frozen while a request is in flight. */
  private busy = false;
  /** Provider whose model list is currently displayed. */
  private modelListOwner: string | null = null;
  /** A memory generation is running; the button must not be re-enterable. */
  private memoryBusy = false;

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
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.submit();
      }
    });
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
    this.composerBar.append(this.statusEl, this.stopBtn, this.sendBtn);
    composer.append(this.input, this.composerBar);

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
    if (!q) return;
    this.input.value = "";
    this.deps.onSend(q);
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
   * Show what reading memory this document has.
   *
   * The state line is the honest bit: whether the notes are being folded into
   * answers is something the user must be able to see, because it changes what
   * the model knows without the transcript mentioning it.
   */
  setMemoryState(memory: MemoryFile | null): void {
    this.memoryBusy = false;
    if (!memory) {
      this.memoryState.textContent = "无（超长文档可先生成）";
      this.memoryState.classList.remove("on");
      this.memoryBtn.textContent = "生成";
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
   * Re-render the transcript.
   *
   * `liveId` is the turn currently streaming: it is drawn as plain text so we
   * do not re-parse markdown on every token.
   */
  render(turns: ChatTurn[], liveId: string | null): void {
    const signature =
      turns.map((t) => `${t.id}:${t.phase}:${t.content.length}`).join("|") + `#${liveId}`;
    const structureChanged = signature !== this.lastRenderedSignature;
    this.lastRenderedSignature = signature;
    this.liveTurnId = liveId;
    void structureChanged;

    const atBottom =
      this.transcript.scrollTop + this.transcript.clientHeight >= this.transcript.scrollHeight - 24;

    this.transcript.textContent = "";
    if (!turns.length) {
      const empty = document.createElement("div");
      empty.className = "ai-empty";
      empty.textContent =
        "在 PDF 中选中文字后点「解释」或「翻译」，或在下方直接提问。";
      this.transcript.appendChild(empty);
      return;
    }

    for (const t of turns) {
      this.transcript.appendChild(this.renderTurn(t));
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
