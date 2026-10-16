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

/* ------------------------------------------------------------------ AI ---- */

import type {
  AiProfile,
  AiStreamEvent,
  ChatMessage,
  ConnectionTest,
  MemoryFile,
  ModelOption,
  ProfileStatus,
} from "./ai/types";
import { Channel } from "@tauri-apps/api/core";

export async function aiListProfiles(): Promise<ProfileStatus[]> {
  return await invoke<ProfileStatus[]>("ai_list_profiles");
}

export async function aiProviderPresets(): Promise<AiProfile[]> {
  return await invoke<AiProfile[]>("ai_provider_presets");
}

/**
 * Fetch the provider's live model catalogue.
 *
 * Deliberately a network call rather than a list shipped in the app: provider
 * catalogues change weekly, so any baked-in list is wrong within a release.
 * Works with no profile at all — OpenCode's catalogue answers unauthenticated,
 * so the free models can be browsed before anything is saved. A key is only
 * ever used when `profileId` names a saved profile.
 */
export async function aiListModels(baseUrl: string, profileId?: string): Promise<ModelOption[]> {
  // No session header here: OpenCode's guidance is that catalogue requests are
  // not part of a conversation and so are not pinned to a backend. The header is
  // an inference-only concern, sent by the chat path.
  return await invoke<ModelOption[]>("ai_list_models", {
    baseUrl,
    profileId: profileId ?? null,
  });
}

export async function aiSaveProfile(profile: AiProfile): Promise<ProfileStatus> {
  return await invoke<ProfileStatus>("ai_save_profile", { profile });
}

export async function aiDeleteProfile(id: string, deleteCredential: boolean): Promise<void> {
  await invoke("ai_delete_profile", { id, deleteCredential });
}

/**
 * One complete answer, collected in Rust instead of streamed.
 *
 * For jobs that must hold the whole reply before acting on it — currently the
 * reading-memory pipeline, where storing a half-received note would be
 * permanent damage.
 */
export async function aiAskOnce(profileId: string, messages: ChatMessage[]): Promise<string> {
  return await invoke<string>("ai_ask_once", { profileId, messages });
}

/**
 * Reading memory for a document, stored beside the PDF.
 *
 * Every call takes the *PDF's* path; Rust derives the sidecar location. There is
 * deliberately no way to name an arbitrary destination — this writes to a
 * user's document folder, so the destination must not be caller-chosen.
 */
export async function aiMemoryRead(pdfPath: string): Promise<MemoryFile | null> {
  return await invoke<MemoryFile | null>("ai_memory_read", { pdfPath });
}

export async function aiMemoryWrite(pdfPath: string, body: string): Promise<MemoryFile> {
  return await invoke<MemoryFile>("ai_memory_write", { pdfPath, body });
}

export async function aiMemoryAppend(
  pdfPath: string,
  heading: string,
  entry: string
): Promise<MemoryFile> {
  return await invoke<MemoryFile>("ai_memory_append", { pdfPath, heading, entry });
}

/**
 * Store or replace the API key. There is deliberately no counterpart that reads
 * it back — the UI can only ask whether one exists.
 */
export async function aiSetKey(profileId: string, key: string): Promise<void> {
  await invoke("ai_set_key", { profileId, key });
}

export async function aiDeleteKey(profileId: string): Promise<void> {
  await invoke("ai_delete_key", { profileId });
}

export async function aiHasKey(profileId: string): Promise<boolean> {
  return await invoke<boolean>("ai_has_key", { profileId });
}

export async function aiTestConnection(
  profileId: string,
  baseUrl?: string,
  model?: string
): Promise<ConnectionTest> {
  return await invoke<ConnectionTest>("ai_test_connection", { profileId, baseUrl, model });
}

export async function aiCancelChat(requestId: string): Promise<boolean> {
  return await invoke<boolean>("ai_cancel_chat", { requestId });
}

export async function aiCancelAll(): Promise<number> {
  return await invoke<number>("ai_cancel_all");
}

export async function aiActiveRequests(): Promise<number> {
  return await invoke<number>("ai_active_requests");
}

/**
 * Start a streamed completion.
 *
 * `onEvent` receives every event the backend emits for this request. The
 * promise resolves when the backend has spawned the task, not when the answer
 * finishes — deltas arrive later through the channel.
 */
export async function aiStartChat(
  requestId: string,
  profileId: string,
  messages: ChatMessage[],
  onEvent: (ev: AiStreamEvent) => void,
  temperature?: number,
  /**
   * Stable id for this conversation. Rust forwards it as `x-opencode-session`
   * for profiles that ask for it, and ignores it otherwise. A random
   * conversation id, never a credential.
   */
  sessionId?: string
): Promise<void> {
  const channel = new Channel<AiStreamEvent>();
  channel.onmessage = onEvent;
  await invoke("ai_start_chat", {
    requestId,
    profileId,
    messages,
    temperature,
    sessionId: sessionId ?? null,
    sink: channel,
  });
}

/* ---------------------------------------------------- save recovery (K-07) -- */

export interface RecoveryCandidate {
  path: string;
  kind: "old" | "bak" | "temp" | string;
  bytes: number;
  valid_pdf: boolean;
  sha256: string;
  invalid_reason: string | null;
}

export interface RecoveryReport {
  target_exists: boolean;
  target_bytes: number;
  target_sha256: string;
  target_invalid_reason: string | null;
  candidates: RecoveryCandidate[];
  needs_recovery: boolean;
  leftover_temps: string[];
  summary: string;
}

export interface RecoveryResult {
  ok: boolean;
  code: string;
  message: string;
  target: string;
  restored_from: string | null;
  displaced_to: string | null;
}

export type RecoveryAction = "restore_old" | "keep_new" | "clean_temps";

/** Read-only scan. Never modifies anything — safe to call on every open. */
export async function scanRecovery(path: string): Promise<RecoveryReport> {
  return await invoke<RecoveryReport>("scan_save_recovery", { path });
}

/** Apply an explicit user choice. Idempotent. */
export async function applyRecovery(
  path: string,
  action: RecoveryAction
): Promise<RecoveryResult> {
  return await invoke<RecoveryResult>("apply_save_recovery", { path, action });
}

/**
 * Ask the user what to do about a recoverable save.
 *
 * Rendered in-app rather than via the dialog plugin so we can offer the real
 * three-way choice (restore / keep current / decide later) and show it only
 * when something is actually recoverable.
 */
export function askRecovery(summary: string): Promise<"restore" | "keep" | "later"> {
  return new Promise((resolve) => {
    const modal = document.createElement("div");
    modal.id = "recovery-modal";
    modal.innerHTML = `
      <div class="rm-card">
        <div class="rm-title">上次保存可能未完成</div>
        <div class="rm-text">${escapeHtml(summary)}</div>
        <div class="rm-actions">
          <button data-act="restore" class="primary">恢复上一版本</button>
          <button data-act="keep">保留当前文档</button>
          <button data-act="later">稍后决定</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener("click", (e) => {
      const act = (e.target as HTMLElement)?.dataset?.act;
      if (!act) return;
      modal.remove();
      resolve(act as "restore" | "keep" | "later");
    });
  });
}

