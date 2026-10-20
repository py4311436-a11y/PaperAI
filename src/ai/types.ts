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
  /**
   * Per-image token charge, when the provider publishes a flat one.
   *
   * Absent for providers whose image cost depends on the image itself, which is
   * most of them. The UI must say "unknown" rather than invent a number — see
   * the note on `ContextStats.images`.
   */
  image_tokens?: number;
}

/**
 * A document's reading memory, as stored beside the PDF.
 *
 * `content` never includes the file's marker line: that belongs to the file,
 * not to the notes. Rust owns the on-disk invariants (the cap, and the refusal
 * to touch a file it did not write).
 */
export interface MemoryFile {
  path: string;
  exists: boolean;
  bytes: number;
  /** `YYYY-MM-DD HH:MM` of the last write, when it exists. */
  updatedAt?: string | null;
  /** e.g. `1–120（共 150 页）` */
  coveredPages?: string | null;
  content: string;
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

/**
 * One image reference, in the OpenAI-compatible block shape.
 *
 * `url` is a `data:` URL carrying already-downscaled base64 — Rust refuses
 * anything that is not `data:` or `https://`, so an `http://` screenshot of a
 * paper cannot leave the machine in cleartext by accident.
 */
export interface ImageUrlBlock {
  image_url: {
    url: string;
    detail?: "low" | "high" | "auto";
  };
}

/** One block of a multimodal message. Mirrors `ContentPart` in `types.rs`. */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: ImageUrlBlock["image_url"] };

/**
 * A screenshot the user attached to a question.
 *
 * `url` is final: already downscaled, already encoded. Nothing downstream
 * re-encodes it, so what the UI shows is byte-for-byte what gets sent.
 */
export interface ImageAttachment {
  id: string;
  /** `data:image/png;base64,...` */
  url: string;
  /** Base64 character count, for the size label in the UI. */
  chars: number;
  width: number;
  height: number;
  /** How it was captured — shown per message so the source is never ambiguous. */
  source: "region" | "page";
  /** 1-based page it came from, when known. */
  page?: number;
  /**
   * The text of the region, read from the page's text layer.
   *
   * Present when the page has text and the selection covered some of it. It is
   * exact — the layer is where the words came from — so a translation of it
   * cannot misread a glyph the way a vision model can.
   */
  text?: string;
  /**
   * Send the text instead of the image.
   *
   * Off by default: a figure is worth seeing, and text alone cannot describe
   * one. The reader turns it on when what they want is the words — a
   * translation, a quote, a definition.
   */
  preferText?: boolean;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  /**
   * Plain text, or a block array when the message carries images.
   *
   * Text-only messages stay strings on purpose: providers match on the request
   * prefix, and the document message has to be byte-identical between turns for
   * the cache to hold. Rust collapses an all-text block list back to a string,
   * so the invariant does not depend on this side remembering.
   */
  content: string | ContentPart[];
  /** Set on an assistant message that asked to call tools. */
  tool_calls?: ToolCall[];
  /** Set on a `tool` message: which call it answers. */
  tool_call_id?: string;
}

export type AiStreamEvent =
  | { type: "started" }
  | { type: "delta"; text: string }
  | { type: "completed"; finish_reason: string | null }
  | { type: "cancelled" }
  | { type: "error"; code: string; safe_message: string }
  /**
   * The model asked to call a tool instead of answering.
   *
   * Terminal, and mutually exclusive with `completed`. Sent as a structured
   * field, never as text inside `delta` — that is the whole reason the refetch
   * path uses tool calling: a document cannot forge a field it has no access to,
   * while a marker in prose is just characters the paper could also contain.
   */
  | { type: "tool_calls"; calls: ToolCall[] };

/** One function call the model requested. */
export interface ToolCall {
  id: string;
  type: string;
  function: {
    name: string;
    /** JSON-encoded, exactly as the model produced it. */
    arguments: string;
  };
}

/** A tool offered to the model for one request. */
export interface ToolDef {
  type: string;
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

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
  | "whole-document"
  | "whole-document-images";

export interface ContextStats {
  chars: number;
  approx_tokens: number;
  truncated: boolean;
  /**
   * Characters of *document* content actually sent — notes count, the question
   * does not.
   *
   * Exists because `chars` cannot answer "did this request carry the paper?":
   * it also counts the question and the history, so an empty document still
   * produces a positive number. The caller uses this to decide whether the
   * document was readable at all, and getting it wrong once already made a
   * notes-based request look like a blank scan.
   */
  document_chars: number;
  pages_sent: number[];
  /** Total pages in the document, so the UI can show real coverage. */
  pages_total: number;
  /**
   * Images attached to this question.
   *
   * Counted separately from `chars` on purpose: a screenshot's base64 is three
   * orders of magnitude larger than its caption, and its token cost is set by
   * the provider's per-image cap (DeepSeek's is a flat 384) rather than by
   * anything we can measure locally. So the number is reported as a count and
   * never folded into a token estimate that would look authoritative and be
   * wrong.
   */
  images: number;
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
  /**
   * Screenshots sent with this turn, kept for display.
   *
   * The transcript has to show what was actually asked about: a question whose
   * only subject is a figure is unreadable later without the figure. The same
   * `data:` URLs go back into `history`, so the model keeps the context it
   * answered with.
   */
  attachments?: ImageAttachment[];
  createdAt: number;
}
