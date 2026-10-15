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

/** Context modes. `none` is the only one that sends no document text. */
export type ContextMode = "none" | "selection" | "current-page" | "nearby-pages";

export interface ContextStats {
  chars: number;
  approx_tokens: number;
  truncated: boolean;
  pages_sent: number[];
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
