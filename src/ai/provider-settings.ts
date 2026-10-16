/**
 * Provider settings dialog.
 *
 * Credential handling is the point of this screen:
 *   - the key field is `type=password` and is cleared immediately after a
 *     successful save; nothing ever reads it back from the backend;
 *   - when a key already exists the UI shows "已配置" and offers delete /
 *     replace, never a masked value it cannot actually produce;
 *   - "测试连接" is a separate, explicit button that says it may cost a small
 *     amount, so saving settings is never disguised as a free probe.
 */

import type { AiProfile, ModelOption, ProfileStatus } from "./types";

/** Edit state = the persisted profile plus the credential *state* (never value). */
interface EditState extends AiProfile {
  hasKey: boolean;
}

export interface SettingsDeps {
  list: () => Promise<ProfileStatus[]>;
  /** Built-in provider presets. Fetched once per dialog open. */
  presets: () => Promise<AiProfile[]>;
  /**
   * The provider's live model catalogue. A network call, not a local list:
   * catalogues change weekly, so anything shipped in the app goes stale.
   */
  /** Fetch a provider's live model catalogue. No session header: catalogue
   * requests are not part of a conversation, so they are not pinned to a
   * backend (OpenCode's own guidance). */
  listModels: (baseUrl: string, profileId?: string) => Promise<ModelOption[]>;
  save: (p: AiProfile) => Promise<ProfileStatus>;
  remove: (id: string, deleteCredential: boolean) => Promise<void>;
  setKey: (id: string, key: string) => Promise<void>;
  deleteKey: (id: string) => Promise<void>;
  test: (id: string, baseUrl: string, model: string) => Promise<import("./types").ConnectionTest>;
  onChanged: () => void;
}

export class ProviderSettings {
  private overlay: HTMLElement;
  private profiles: ProfileStatus[] = [];
  private editing: EditState | null = null;
  /** Cached for the lifetime of one dialog open; presets are static. */
  private availablePresets: AiProfile[] = [];
  /** Live catalogue from the last successful fetch, for the model hint. */
  private lastModels: ModelOption[] = [];
  private modelSelect: HTMLSelectElement | null = null;
  private modelHint: HTMLElement | null = null;

  constructor(private deps: SettingsDeps) {
    this.overlay = document.createElement("div");
    this.overlay.id = "ai-settings";
    this.overlay.hidden = true;
    this.overlay.addEventListener("click", (e) => {
      if (e.target === this.overlay) this.hide();
    });
    // Escape closes. Registered on the document rather than the overlay so it
    // works no matter which control inside the card has focus.
    this.onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !this.overlay.hidden) {
        e.stopPropagation();
        this.hide();
      }
    };
  }

  private onKeydown: (e: KeyboardEvent) => void;

  async open(): Promise<void> {
    document.body.appendChild(this.overlay);
    this.overlay.hidden = false;
    document.addEventListener("keydown", this.onKeydown);
    try {
      this.availablePresets = await this.deps.presets();
    } catch {
      // A missing preset list must not prevent the dialog from opening; the
      // custom-provider path still works.
      this.availablePresets = [];
    }
    await this.reload();
  }

  /**
   * Pull the provider's live catalogue into the datalist.
   *
   * Deliberately a separate, explicit action rather than something that happens
   * on save: it is a network request to a third party, and the user should be
   * the one deciding when that happens.
   */
  private async fetchModels(): Promise<void> {
    const e = this.editing;
    if (!e) return;
    if (!e.base_url || e.base_url === "https://") {
      this.setStatus("请先填写 Base URL。", "warn");
      return;
    }
    this.setStatus("正在拉取模型列表…", "warn");
    try {
      // The profile may not be saved yet, so the id is passed as a hint only —
      // Rust ignores it unless it names a saved profile, which is what keeps a
      // stored key from being sent to a host it was never configured for.
      const models = await this.deps.listModels(e.base_url, e.id);
      this.lastModels = models;
      this.fillModelSelect(models);
      const incompatible = models.filter((m) => m.compatibility === "incompatible").length;
      const free = models.filter((m) => m.free_hint).length;
      this.setStatus(
        `已拉取 ${models.length} 个模型，在 Model 右侧下拉框中选择。` +
          (free ? `其中 ${free} 个名称含 -free（可能免费）。` : "") +
          (incompatible ? `有 ${incompatible} 个使用其它协议，已标注。` : ""),
        "ok"
      );
      this.updateModelHint();
    } catch (err) {
      this.lastModels = [];
      this.fillModelSelect([]);
      this.setStatus(describe(err), "err");
      this.updateModelHint();
    }
  }

  /**
   * Build the model dropdown from a catalogue.
   *
   * Called both after a fetch and from `render()`, because `render()` rebuilds
   * the whole card: without this the list would vanish every time the dialog
   * re-rendered (picking a preset, saving, toggling a field) while the status
   * line still claimed the models had been loaded.
   */
  private fillModelSelect(models: ModelOption[]): void {
    const sel = this.modelSelect;
    if (!sel) return;
    sel.textContent = "";

    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = models.length
      ? `— 从 ${models.length} 个模型中选择 —`
      : "— 尚未拉取，点「拉取可用模型」—";
    sel.appendChild(placeholder);

    const manual = document.createElement("option");
    manual.value = MANUAL_ID;
    manual.textContent = "✎ 手动输入（不使用此列表）";
    sel.appendChild(manual);

    for (const m of models) {
      const o = document.createElement("option");
      o.value = m.id;
      const marks: string[] = [];
      if (m.free_hint) marks.push("可能免费（名称含 -free）");
      if (m.compatibility === "incompatible") marks.push("⚠ 其它协议，不可用");
      o.textContent = marks.length ? `${m.id}　—　${marks.join("；")}` : m.id;
      sel.appendChild(o);
    }

    // Pre-select whatever the profile already uses, if it is on the list.
    const current = this.editing?.model.trim() ?? "";
    sel.value = models.some((m) => m.id === current) ? current : MANUAL_ID;
  }

  /**
   * Keep the dropdown honest while the user types.
   *
   * Typed text wins, so the selection falls back to 「手动输入」 rather than
   * silently showing a stale highlight next to a different value.
   */
  private syncSelectFromInput(): void {
    const sel = this.modelSelect;
    const want = this.editing?.model.trim() ?? "";
    if (!sel || sel.value === want) return;
    sel.value = [...sel.options].some((o) => o.value === want && want !== "") ? want : MANUAL_ID;
  }

  /**
   * Warn about the current model *before* the request is attempted.
   *
   * Some providers serve part of their catalogue on `/messages` or `/responses`
   * and give no metadata saying so; picking one produces an error that looks
   * like a bad model name. Saying it here is cheaper than debugging it later.
   */
  private updateModelHint(): void {
    if (!this.modelHint) return;
    const e = this.editing;
    if (!e) {
      this.modelHint.textContent = "";
      return;
    }
    const known = this.lastModels.find((m) => m.id === e.model.trim());
    if (known?.compatibility === "incompatible") {
      this.modelHint.textContent =
        `⚠ 该模型（${known.id}）由服务商在另一个接口协议上提供，` +
        `PaperAI 只支持 OpenAI 兼容的 /chat/completions，调用会失败。请另选一个。`;
      this.modelHint.className = "ais-note ais-warn";
      return;
    }
    this.modelHint.className = "ais-note";
    this.modelHint.textContent = this.lastModels.length
      ? `已拉取 ${this.lastModels.length} 个模型。列表来自服务商实时接口，可能随时变化。`
      : "";
  }

  hide(): void {
    this.overlay.hidden = true;
    document.removeEventListener("keydown", this.onKeydown);
    // Never leave a key sitting in the DOM.
    this.editing = null;
  }

  async reload(): Promise<void> {
    this.profiles = await this.deps.list();
    const current = this.editing
      ? this.profiles.find((p) => p.id === this.editing!.id)
      : this.profiles[0];
    if (!this.editing && current) {
      this.editing = fromStatus(current);
    }
    this.render();
  }

  private render(): void {
    this.overlay.textContent = "";
    // `textContent = ""` detaches the previous datalist and hint; they are
    // rebuilt below, so drop the stale references rather than writing into
    // nodes that are no longer in the document.
    this.modelSelect = null;
    this.modelHint = null;
    const card = document.createElement("div");
    card.className = "ais-card";

    const h = document.createElement("h2");
    h.textContent = "AI 设置";
    card.appendChild(h);

    // --- profile picker -----------------------------------------------------
    const row = (label: string, control: HTMLElement) => {
      const r = document.createElement("div");
      r.className = "ais-row";
      const l = document.createElement("label");
      l.textContent = label;
      r.append(l, control);
      return r;
    };

    const picker = document.createElement("select");
    picker.id = "ais-profile";
    for (const p of this.profiles) {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = `${p.display_name}${p.has_key ? "" : "（未配置 Key）"}`;
      picker.appendChild(o);
    }
    if (this.editing) picker.value = this.editing.id;
    picker.addEventListener("change", () => {
      const p = this.profiles.find((x) => x.id === picker.value);
      if (!p) return;
      this.editing = fromStatus(p);
      this.render();
    });
    card.appendChild(row("Provider", picker));

    // --- presets ------------------------------------------------------------
    // Buttons rather than a dropdown: there are few of them and each one is a
    // complete, verified configuration (base URL + a model known to work).
    if (this.availablePresets.length) {
      const presetWrap = document.createElement("div");
      presetWrap.className = "ais-presets";
      for (const preset of this.availablePresets) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "ais-preset";
        b.id = `ais-preset-${preset.id}`;
        b.textContent = preset.display_name;
        b.title = `${preset.base_url}\n默认模型：${preset.model}`;
        b.addEventListener("click", () => {
          this.editing = { ...preset, hasKey: false };
          this.render();
          void this.fetchModels();
        });
        presetWrap.appendChild(b);
      }
      card.appendChild(row("快速配置", presetWrap));
    }

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "ais-link";
    addBtn.id = "ais-add-custom";
    addBtn.textContent = "+ 添加自定义 OpenAI-compatible Provider";
    addBtn.addEventListener("click", () => {
      const preset = this.availablePresets[0];
      this.editing = {
        ...(preset ?? DEFAULT_EDIT_STATE),
        id: `custom-${Date.now().toString(36)}`,
        display_name: "自定义 Provider",
        base_url: "https://",
        model: "",
        is_default: false,
        sends_session_header: false,
        hasKey: false,
      };
      this.render();
    });
    card.appendChild(addBtn);

    if (!this.editing) {
      const p = document.createElement("p");
      p.className = "ais-note";
      p.textContent = "暂无配置。点击上方按钮添加。";
      card.appendChild(p);
      this.overlay.appendChild(card);
      return;
    }

    const e = this.editing;

    // --- fields -------------------------------------------------------------
    const nameInput = document.createElement("input");
    nameInput.id = "ais-name";
    nameInput.value = e.display_name;
    nameInput.addEventListener("input", () => (e.display_name = nameInput.value));
    card.appendChild(row("显示名称", nameInput));

    const urlInput = document.createElement("input");
    urlInput.id = "ais-base-url";
    urlInput.value = e.base_url;
    urlInput.placeholder = "https://api.deepseek.com";
    urlInput.addEventListener("input", () => (e.base_url = urlInput.value));
    card.appendChild(row("Base URL", urlInput));

    // --- model --------------------------------------------------------------
    // Two controls on purpose:
    //   * a real `<select>` fed by the provider's live catalogue. This started
    //     out as a `<datalist>`, which was the wrong widget twice over — Chromium
    //     filters a datalist against the input's current value (so 46 fetched
    //     models showed as one), and its "type-ahead suggestion" semantics make
    //     picking an item unreliable. A `<select>` always shows the whole list
    //     and always reports a selection.
    //   * a free-text input beside it, because a model id must stay typeable
    //     when the catalogue call fails or the provider ships something new.
    const modelWrap = document.createElement("div");
    modelWrap.className = "ais-modelrow";

    const modelInput = document.createElement("input");
    modelInput.id = "ais-model";
    modelInput.value = e.model;
    modelInput.placeholder = "deepseek-flash";
    modelInput.addEventListener("input", () => {
      e.model = modelInput.value;
      // Typing means the select no longer reflects the value; show that rather
      // than leaving a stale option highlighted.
      this.syncSelectFromInput();
      this.updateModelHint();
    });

    const modelSelect = document.createElement("select");
    modelSelect.id = "ais-model-select";
    modelSelect.className = "ais-modelselect";
    modelSelect.addEventListener("change", () => {
      const picked = modelSelect.value;
      if (!picked || picked === MANUAL_ID) return;
      modelInput.value = picked;
      e.model = picked;
      this.updateModelHint();
    });
    this.modelSelect = modelSelect;

    const fetchBtn = document.createElement("button");
    fetchBtn.type = "button";
    fetchBtn.id = "ais-fetch-models";
    fetchBtn.className = "ais-link";
    fetchBtn.textContent = "拉取可用模型";
    fetchBtn.addEventListener("click", () => void this.fetchModels());

    modelWrap.append(modelInput, this.modelSelect, fetchBtn);
    // `render()` wipes the card, so the list is rebuilt from the last fetch.
    this.fillModelSelect(this.lastModels);
    card.appendChild(row("Model", modelWrap));

    this.modelHint = document.createElement("p");
    this.modelHint.id = "ais-model-hint";
    this.modelHint.className = "ais-note";
    card.appendChild(this.modelHint);

    // --- credential ---------------------------------------------------------
    const keyWrap = document.createElement("div");
    keyWrap.className = "ais-keyrow";
    const keyInput = document.createElement("input");
    keyInput.type = "password";
    keyInput.id = "ais-api-key";
    keyInput.autocomplete = "off";
    keyInput.spellcheck = false;
    keyInput.placeholder = e.hasKey ? "已配置（输入新值可替换）" : "粘贴 API Key";
    const saveKey = document.createElement("button");
    saveKey.type = "button";
    saveKey.id = "ais-save-key";
    saveKey.textContent = e.hasKey ? "替换" : "保存";
    const delKey = document.createElement("button");
    delKey.type = "button";
    delKey.id = "ais-delete-key";
    delKey.textContent = "删除";
    delKey.disabled = !e.hasKey;
    keyWrap.append(keyInput, saveKey, delKey);

    saveKey.addEventListener("click", async () => {
      const v = keyInput.value.trim();
      if (!v) {
        this.setStatus("请先输入 API Key", "warn");
        return;
      }
      try {
        // Persist the non-secret fields first so the profile exists.
        await this.deps.save(stripEditState(e));
        await this.deps.setKey(e.id, v);
        // Never keep the plaintext in the DOM.
        keyInput.value = "";
        this.setStatus("API Key 已保存到系统凭据管理器", "ok");
        this.deps.onChanged();
        await this.reload();
      } catch (err) {
        this.setStatus(`保存失败：${describe(err)}`, "err");
      }
    });

    delKey.addEventListener("click", async () => {
      try {
        await this.deps.deleteKey(e.id);
        this.setStatus("已删除本机保存的 API Key", "ok");
        this.deps.onChanged();
        await this.reload();
      } catch (err) {
        this.setStatus(`删除失败：${describe(err)}`, "err");
      }
    });

    card.appendChild(row("API Key", keyWrap));

    const keyState = document.createElement("div");
    keyState.className = "ais-note";
    keyState.textContent = e.hasKey
      ? "状态：已配置（密钥保存在 Windows 凭据管理器，界面无法读回明文）"
      : "状态：未配置";
    card.appendChild(keyState);

    // --- status + actions ---------------------------------------------------
    const status = document.createElement("div");
    status.className = "ais-status";
    status.id = "ais-status";
    card.appendChild(status);

    const actions = document.createElement("div");
    actions.className = "ais-actions";

    const testBtn = document.createElement("button");
    testBtn.type = "button";
    testBtn.id = "ais-test";
    testBtn.textContent = "测试连接";
    testBtn.addEventListener("click", async () => {
      this.setStatus("正在测试…（会发送一次极短的请求，可能产生少量费用）", "warn");
      try {
        await this.deps.save(stripEditState(e));
        const r = await this.deps.test(e.id, e.base_url, e.model);
        this.setStatus(
          r.ok
            ? `连接正常（${r.elapsed_ms} ms${r.model_echo ? `，模型：${r.model_echo}` : ""}）`
            : `${r.message}（${r.code}）`,
          r.ok ? "ok" : "err"
        );
        this.deps.onChanged();
      } catch (err) {
        this.setStatus(`测试失败：${describe(err)}`, "err");
      }
    });

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.id = "ais-save";
    saveBtn.className = "primary";
    saveBtn.textContent = "保存设置";
    saveBtn.addEventListener("click", async () => {
      try {
        await this.deps.save(stripEditState(e));
        this.setStatus("设置已保存（不含密钥）", "ok");
        this.deps.onChanged();
        await this.reload();
      } catch (err) {
        this.setStatus(`保存失败：${describe(err)}`, "err");
      }
    });

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.id = "ais-delete-profile";
    delBtn.className = "danger";
    delBtn.textContent = "删除该 Provider";
    delBtn.addEventListener("click", async () => {
      const alsoKey = window.confirm(
        "同时删除本机为该 Provider 保存的 API Key？\n确定 = 一起删除，取消 = 仅删除配置"
      );
      try {
        await this.deps.remove(e.id, alsoKey);
        this.editing = null;
        this.deps.onChanged();
        await this.reload();
      } catch (err) {
        this.setStatus(`删除失败：${describe(err)}`, "err");
      }
    });

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.id = "ais-close";
    closeBtn.textContent = "关闭";
    closeBtn.addEventListener("click", () => this.hide());

    actions.append(testBtn, saveBtn, delBtn, closeBtn);
    card.appendChild(actions);

    // --- privacy notice ------------------------------------------------------
    const privacy = document.createElement("p");
    privacy.className = "ais-privacy";
    privacy.textContent =
      "隐私：只有当你点击「解释 / 翻译 / 发送」时，才会把该次指定的文本上下文发给上面这个地址。" +
      "应用不会自动上传整份 PDF，也不会在后台发送任何内容。";
    card.appendChild(privacy);

    if (e.base_url.startsWith("http://")) {
      const warn = document.createElement("p");
      warn.className = "ais-warn";
      warn.textContent =
        "本地非加密连接：该地址使用明文 HTTP（仅允许 localhost / 127.0.0.1）。";
      card.appendChild(warn);
    }

    this.overlay.appendChild(card);
    // Show the protocol warning for an already-saved model id too, not only for
    // one the user just picked from the list.
    this.updateModelHint();
    if (this.pendingStatus) {
      this.setStatus(this.pendingStatus.text, this.pendingStatus.kind);
    }
  }

  private pendingStatus: { text: string; kind: StatusKind } | null = null;

  private setStatus(text: string, kind: StatusKind): void {
    const el = this.overlay.querySelector("#ais-status") as HTMLElement | null;
    if (!el) {
      this.pendingStatus = { text, kind };
      return;
    }
    this.pendingStatus = null;
    el.textContent = text;
    el.dataset.kind = kind;
  }
}

type StatusKind = "ok" | "err" | "warn";

/** Sentinel option value meaning "keep typing in the input". */
const MANUAL_ID = "__manual__";

/**
 * Seed for the "custom provider" form. Only used for field shapes — the user
 * overwrites every value. `sentinel` fields keep the type honest so the form
 * does not need a second, parallel type.
 */
const DEFAULT_EDIT_STATE: EditState = {
  id: "",
  display_name: "",
  base_url: "https://",
  model: "",
  credential_id: "",
  is_default: false,
  sends_session_header: false,
  hasKey: false,
};


function fromStatus(p: ProfileStatus): EditState {
  return {
    id: p.id,
    display_name: p.display_name,
    base_url: p.base_url,
    model: p.model,
    credential_id: p.id,
    is_default: p.is_default,
    sends_session_header: p.sends_session_header,
    hasKey: p.has_key,
  };
}

/** Never send the UI-only credential state to the backend. */
function stripEditState(e: EditState): AiProfile {
  const { hasKey, ...profile } = e;
  void hasKey;
  return profile;
}

function describe(e: unknown): string {
  if (typeof e === "string") return e;
  if (typeof e === "object" && e && "message" in e) {
    return String((e as { message: unknown }).message);
  }
  return String(e);
}
