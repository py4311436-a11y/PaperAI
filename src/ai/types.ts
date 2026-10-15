/**
 * Frontend types for the AI layer. Mirrors `src-tauri/src/ai/types.rs`.
 *
 * Nothing here can hold a credential: the UI only ever learns whether a key
 * exists (`hasKey`), never its value.
 */

export interface AiProfile {
  id: string;
  display_name: string;
  base_url: string;
  model: string;
  credential_id: string;
  is_default: boolean;
  /**
   * Send a stable `x-opencode-session` header on every request. OpenCode's
   * gateway asks clients for this (routing + prompt caching) and warns that
   * requests without it may start failing. A conversation id, not a secret.
   */
  sends_session_header: boolean;
}

export interface ProfileStatus {
  id: string;
  display_name: string;
  base_url: string;
  model: string;
  is_default: boolean;
  has_key: boolean;
  /** Plain HTTP to this machine — shown in the UI as an explicit warning. */
  is_loopback_insecure: boolean;
  sends_session_header: boolean;
}

/** One entry from a provider's live model catalogue. */
export interface ModelOption {
  id: string;
  /**
   * `incompatible` — the provider serves this model on a different protocol
   * (`/messages`, `/responses`) than the OpenAI-compatible one this app speaks.
   * `unknown` — the usual case, and normally fine.
   */
  compatibility: "chat" | "incompatible" | "unknown" | string;
  /** Inferred from a `-free` suffix; used only to sort, never as fact. */
  free_hint: boolean;
}

export interface ConnectionTest {
  ok: boolean;
  code: string;
  message: string;
  elapsed_ms: number;
  model_echo: string | null;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type AiStreamEvent =
  | { type: "started" }
  | { type: "delta"; text: string }
  | { type: "completed"; finish_reason: string | null }
  | { type: "cancelled" }
  | { type: "error"; code: string; safe_message: string };

/**
 * Context modes. `none` is the only one that sends no document text.
 *
 * `whole-document` is the expensive one: it walks every page. It exists because
 * "简要概述这篇文章" is a normal thing to ask, and no per-page mode can answer
 * it honestly.
 */
export type ContextMode =
  | "none"
  | "selection"
  | "current-page"
  | "nearby-pages"
  | "whole-document";

export interface ContextStats {
  chars: number;
  approx_tokens: number;
  truncated: boolean;
  pages_sent: number[];
  /** Total pages in the document, so the UI can show real coverage. */
  pages_total: number;
}

/** A frozen copy of a PDF text selection. */
export interface SelectionSnapshot {
  /** Identifies the document the selection came from. Not a filesystem path. */
  documentId: string;
  /** 1-based page numbers covered. */
  pageNumbers: number[];
  text: string;
  capturedAt: number;
  source: "pdf-text-layer";
}

/** Chat lifecycle. Exactly one terminal state per request. */
export type ChatPhase =
  | "idle"
  | "preparing"
  | "streaming"
  | "completed"
  | "cancelling"
  | "cancelled"
  | "error";

export interface ChatTurn {
  id: string;
  role: "user" | "assistant";
  /** Raw markdown+LaTeX as returned by the model. */
  content: string;
  phase: ChatPhase;
  /** Set when phase is `error`. */
  errorCode?: string;
  errorMessage?: string;
  /** Which context produced this turn — shown per message. */
  contextLabel?: string;
  createdAt: number;
}
