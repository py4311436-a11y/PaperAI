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

import type { AiProfile, ProfileStatus } from "./types";

/** Edit state = the persisted profile plus the credential *state* (never value). */
interface EditState extends AiProfile {
  hasKey: boolean;
}

export interface SettingsDeps {
  list: () => Promise<ProfileStatus[]>;
  preset: () => Promise<AiProfile>;
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

  constructor(private deps: SettingsDeps) {
    this.overlay = document.createElement("div");
    this.overlay.id = "ai-settings";
    this.overlay.hidden = true;
    this.overlay.addEventListener("click", (e) => {
      if (e.target === this.overlay) this.hide();
    });
  }

  async open(): Promise<void> {
    document.body.appendChild(this.overlay);
    this.overlay.hidden = false;
    await this.reload();
  }

  hide(): void {
    this.overlay.hidden = true;
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

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "ais-link";
    addBtn.textContent = "+ 添加 OpenAI-compatible Provider";
    addBtn.addEventListener("click", async () => {
      const preset = await this.deps.preset();
      this.editing = {
        ...preset,
        id: `custom-${Date.now().toString(36)}`,
        display_name: "自定义 Provider",
        base_url: "https://",
        model: "",
        is_default: false,
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

    const modelInput = document.createElement("input");
    modelInput.id = "ais-model";
    modelInput.value = e.model;
    modelInput.placeholder = "deepseek-chat";
    modelInput.addEventListener("input", () => (e.model = modelInput.value));
    card.appendChild(row("Model", modelInput));

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

function fromStatus(p: ProfileStatus): EditState {
  return {
    id: p.id,
    display_name: p.display_name,
    base_url: p.base_url,
    model: p.model,
    credential_id: p.id,
    is_default: p.is_default,
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
