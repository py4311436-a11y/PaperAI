/**
 * Tauri bridge — the ONLY place the frontend talks to the Rust backend.
 *
 * Least privilege: the frontend never touches the filesystem directly. It asks
 * the backend to (a) validate + read a path that came from the picker or the OS
 * shell, and (b) write bytes through the DocumentSaveService.
 */
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog, message } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";

export const OPEN_FILES_EVENT = "paperai://open-files";

export const isTauri = "__TAURI_INTERNALS__" in window || "__TAURI__" in window;

export interface OpenedFile {
  path: string;
  name: string;
  size: number;
  readonly: boolean;
}

export interface PathInfo {
  exists: boolean;
  is_file: boolean;
  size: number;
  readonly: boolean;
  is_pdf: boolean;
}

export interface SaveResult {
  ok: boolean;
  code: string;
  message: string;
  target: string;
  bytes: number;
  sha256: string;
  backup_path: string | null;
  leftover_temp: string | null;
}

export interface SaveRequest {
  target_path: string;
  data_base64: string;
  make_backup: boolean;
  inject_failure?: string;
}

/** Ask the user to pick a PDF. Returns null on cancel. */
export async function pickPdf(): Promise<OpenedFile | null> {
  const selected = await openDialog({
    multiple: false,
    directory: false,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (!selected || Array.isArray(selected)) return null;
  return await invoke<OpenedFile>("open_pdf", { path: selected });
}

/** Validate + normalise a path handed over by the shell / CLI / picker. */
export async function invokeOpen(path: string): Promise<OpenedFile> {
  return await invoke<OpenedFile>("open_pdf", { path });
}

/** Read validated PDF bytes from the backend (raw ArrayBuffer, not JSON). */
export async function readPdf(path: string): Promise<Uint8Array> {
  const buf = await invoke<ArrayBuffer>("read_pdf_file", { path });
  return new Uint8Array(buf);
}

export async function statPath(path: string): Promise<PathInfo> {
  return await invoke<PathInfo>("stat_path", { path });
}

export async function sha256Of(path: string): Promise<string> {
  return await invoke<string>("sha256_of", { path });
}

export async function saveDocument(req: SaveRequest): Promise<SaveResult> {
  return await invoke<SaveResult>("save_document", { req });
}

/** Drain files handed over before the frontend was ready. */
export async function takePendingFiles(): Promise<string[]> {
  return await invoke<string[]>("take_pending_files");
}

/**
 * Three-way dirty prompt: save / discard / cancel.
 *
 * The dialog plugin only offers ok/cancel, and the task requires a real
 * three-way choice, so this is rendered in-app (no extra capability needed).
 */
export function askDirty(name: string): Promise<"save" | "discard" | "cancel"> {
  return new Promise((resolve) => {
    const modal = document.createElement("div");
    modal.id = "dirty-modal";
    modal.innerHTML = `
      <div class="dm-card">
        <div class="dm-title">未保存的批注</div>
        <div class="dm-text">“${escapeHtml(name || "当前文档")}” 有未保存的批注。是否保存？</div>
        <div class="dm-actions">
          <button data-act="save">保存</button>
          <button data-act="discard">不保存</button>
          <button data-act="cancel" class="primary">取消</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener("click", (e) => {
      const act = (e.target as HTMLElement)?.dataset?.act;
      if (!act) return;
      modal.remove();
      resolve(act as "save" | "discard" | "cancel");
    });
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string
  );
}

export async function showMessage(text: string): Promise<void> {
  await message(text, { title: "PaperAI", kind: "info" });
}

export async function pickSaveTarget(defaultName: string): Promise<string | null> {
  const p = await saveDialog({
    defaultPath: defaultName,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  return p ?? null;
}

/**
 * Subscribe to files forwarded by a second instance.
 * Outside Tauri (browser regression runs) this is a no-op — `listen()` would
 * throw because `__TAURI_INTERNALS__.transformCallback` does not exist.
 */
export function onOpenFiles(cb: (paths: string[]) => void): Promise<() => void> {
  if (!isTauri) return Promise.resolve(() => undefined);
  return listen<string[]>(OPEN_FILES_EVENT, (e) => cb(e.payload ?? []));
}

/** base64 of a Uint8Array, chunked so we never blow the call stack. */
export function toBase64(bytes: Uint8Array): string {
  let out = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    out += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CH)) as unknown as number[]);
  }
  return btoa(out);
}
