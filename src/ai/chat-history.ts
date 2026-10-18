/**
 * The on-disk shape of a document's conversation, and the translation to and
 * from the in-memory session.
 *
 * Kept pure and separate from the controller so the round-trip can be tested
 * without a filesystem or a Tauri bridge. The properties that matter here are
 * all about *not losing things*: timestamps, the page an image came from, and
 * the fact that an answer was interrupted.
 *
 * Deliberately a versioned envelope. The file lives next to someone's papers and
 * may outlast several releases of this app; a bare array would leave no room to
 * change the shape later without guessing at what an old file meant.
 */

import type { ChatMessage, ChatTurn, ImageAttachment } from "./types";

export const CHAT_HISTORY_VERSION = 1;

/** One attachment as stored: a reference, never the bytes. */
export interface StoredAttachment {
  /** Filename inside the sibling `.paperai-chat/` directory. */
  file?: string;
  /**
   * Present only on the way in and out of the bridge.
   *
   * The controller hands the bridge a data URL; Rust writes it and returns the
   * shape with `file` instead. Nothing downstream of the bridge should carry
   * this, or the JSON grows by megabytes.
   */
  dataUrl?: string;
  /** Page the image came from, when it came from one. */
  page?: number;
  width?: number;
  height?: number;
  source?: "region" | "page";
}

export interface StoredTurn {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** ISO 8601 with offset. Stored as text so the file stays readable. */
  createdAt: string;
  contextLabel?: string;
  /**
   * Why an answer is incomplete, e.g. the user stopped it.
   *
   * Kept because it changes what the turn *means*: half an answer read later
   * looks like the model trailed off, and a follow-up question then reads as
   * the app's mistake rather than the user's decision.
   */
  phase?: string;
  attachments?: StoredAttachment[];
}

export interface StoredChat {
  version: number;
  documentTitle?: string;
  updatedAt?: string;
  turns: StoredTurn[];
}

/** ISO string for a timestamp, or null when it is not a usable time. */
function toIso(ms: number | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

/**
 * Has this turn stopped changing?
 *
 * The controller keeps its own private copy for its own purposes; this one
 * exists because the *save* decision needs the same answer. Persisting on every
 * change would rewrite the whole JSON hundreds of times per answer, and
 * persisting while the answer is still streaming would store a truncated one —
 * which then reads later as the model having trailed off.
 */
export function isTerminalPhase(phase: string | undefined): boolean {
  return phase === "completed" || phase === "cancelled" || phase === "error";
}

/**
 * Session turns -> the stored shape.
 *
 * Attachments keep their data URL; the bridge/Rust turns it into a file
 * reference. That split is what keeps this function pure.
 */
export function toStoredChat(input: {
  documentTitle?: string;
  turns: ChatTurn[];
  now?: number;
}): StoredChat {
  const turns: StoredTurn[] = [];
  for (const t of input.turns) {
    // A failed or empty turn is not worth persisting: it carries no content and
    // would come back as a blank bubble with no way to tell what happened.
    if (!t.content.trim() && !(t.attachments?.length ?? 0)) continue;
    const stored: StoredTurn = {
      id: t.id,
      role: t.role,
      content: t.content,
      createdAt: toIso(t.createdAt),
    };
    if (t.contextLabel) stored.contextLabel = t.contextLabel;
    // Never persist a phase that means "still running". A stored `preparing` or
    // `streaming` comes back on the next open as an active turn, which the panel
    // reads as busy — so the send button is disabled from the first second and
    // nothing is in flight to finish. The user has no way to clear it.
    //
    // The turn was interrupted by the app closing, so it is recorded as
    // cancelled: that is what happened, and it is a terminal state.
    if (t.phase && t.phase !== "completed") {
      stored.phase = isTerminalPhase(t.phase) ? t.phase : "cancelled";
    }
    if (t.attachments?.length) {
      stored.attachments = t.attachments.map((a) => ({
        dataUrl: a.url,
        page: a.page,
        width: a.width,
        height: a.height,
        source: a.source,
      }));
    }
    turns.push(stored);
  }
  return {
    version: CHAT_HISTORY_VERSION,
    documentTitle: input.documentTitle,
    updatedAt: toIso(input.now ?? Date.now()),
    turns,
  };
}

/**
 * The stored shape -> session turns.
 *
 * Tolerant on purpose: this reads a file that may be older than the running
 * build, hand-edited, or partially written. Anything unrecognisable is skipped
 * rather than thrown, because losing one turn is recoverable and refusing to
 * open the conversation is not.
 */
export function fromStoredChat(doc: StoredChat | null | undefined): ChatTurn[] {
  if (!doc || !Array.isArray(doc.turns)) return [];
  const out: ChatTurn[] = [];
  for (const t of doc.turns) {
    if (!t || (t.role !== "user" && t.role !== "assistant")) continue;
    const attachments: ImageAttachment[] = [];
    for (const a of t.attachments ?? []) {
      // Only images that actually came back with bytes. A reference whose file
      // is gone yields no dataUrl (the Rust side drops it), and a thumbnail with
      // no source would render as a broken box.
      if (!a?.dataUrl) continue;
      attachments.push({
        id: `${t.id}-att-${attachments.length}`,
        url: a.dataUrl,
        chars: a.dataUrl.length,
        width: a.width ?? 0,
        height: a.height ?? 0,
        source: a.source === "region" ? "region" : "page",
        page: a.page,
      });
    }
    const at = Date.parse(t.createdAt);
    out.push({
      id: t.id || `restored-${out.length}`,
      role: t.role,
      content: typeof t.content === "string" ? t.content : "",
      // A missing timestamp reads as "unknown" rather than "1970", which would
      // look like a real time from a broken clock.
      createdAt: Number.isNaN(at) ? 0 : at,
      // Same coercion on the way in, for files written before the write side
      // learned to prevent it. A non-terminal phase here is a deadlock.
      phase: isTerminalPhase(t.phase) ? (t.phase as ChatTurn["phase"]) : "cancelled",
      contextLabel: t.contextLabel,
      attachments: attachments.length ? attachments : undefined,
    });
  }
  return out;
}

/**
 * "2026-10-18 19:35" for display, in local time.
 *
 * Local, not the stored ISO offset: the user is reading their own conversation
 * on their own machine, and a timestamp in another timezone is a puzzle rather
 * than a fact.
 */
export function formatTurnTime(ms: number | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Rebuild wire messages for a restored turn.
 *
 * Same rule as the live path: text stays a string unless there are images, in
 * which case it becomes a block array. A restored conversation that carried
 * images has to keep them, or follow-up questions are answered about a paper
 * the model can no longer see.
 */
export function turnToMessage(turn: ChatTurn): ChatMessage {
  const attachments = turn.attachments ?? [];
  if (!attachments.length) return { role: turn.role, content: turn.content };
  return {
    role: turn.role,
    content: [
      { type: "text", text: turn.content },
      ...attachments.map((a) => ({ type: "image_url" as const, image_url: { url: a.url } })),
    ],
  };
}
