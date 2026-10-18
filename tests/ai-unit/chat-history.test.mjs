/**
 * Round-tripping a conversation through the store.
 *
 * The properties that matter are all about *not losing things*: the time a turn
 * was sent, the page an image came from, and the fact that an answer was
 * interrupted rather than finished. Each of those is invisible in the happy path
 * and only shows up when the user reopens a document days later — which is
 * exactly why they are tested here rather than found in use.
 *
 * Run via `node scripts/run-ai-unit-tests.mjs`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CHAT_HISTORY_VERSION,
  formatTurnTime,
  fromStoredChat,
  isTerminalPhase,
  toStoredChat,
  turnToMessage,
} from "../../dist-test/src/ai/chat-history.js";

function turn(over = {}) {
  return {
    id: "t1",
    role: "user",
    content: "分阶段是怎么回事",
    phase: "completed",
    createdAt: Date.parse("2026-10-18T11:35:12.000Z"),
    ...over,
  };
}

// ---------------------------------------------------------------- round trip

test("a conversation survives a save and load", () => {
  const turns = [
    turn(),
    turn({ id: "t2", role: "assistant", content: "分三个阶段。", createdAt: Date.parse("2026-10-18T11:35:20.000Z") }),
  ];
  const stored = toStoredChat({ documentTitle: "论文.pdf", turns, now: Date.parse("2026-10-18T11:36:00.000Z") });
  const back = fromStoredChat(JSON.parse(JSON.stringify(stored)));

  assert.equal(back.length, 2);
  assert.equal(back[0].content, "分阶段是怎么回事");
  assert.equal(back[1].role, "assistant");
  assert.equal(back[0].createdAt, turns[0].createdAt, "the timestamp is preserved exactly");
});

test("the stored file is versioned", () => {
  // It lives beside someone's papers and may outlast several releases; a bare
  // array would leave no way to read an old file later.
  const stored = toStoredChat({ turns: [turn()] });
  assert.equal(stored.version, CHAT_HISTORY_VERSION);
});

test("an image keeps the page it came from", () => {
  // The page number is what lets the app skip re-rendering a page the model
  // already has. Losing it would silently double the cost of every follow-up.
  const turns = [
    turn({
      attachments: [
        { id: "a", url: "data:image/jpeg;base64,AAA", chars: 30, width: 10, height: 12, source: "page", page: 5 },
      ],
    }),
  ];
  const back = fromStoredChat(toStoredChat({ turns }));
  assert.equal(back[0].attachments.length, 1);
  assert.equal(back[0].attachments[0].page, 5);
  assert.equal(back[0].attachments[0].source, "page");
  assert.equal(back[0].attachments[0].url, "data:image/jpeg;base64,AAA");
});

test("an empty turn is not persisted", () => {
  // A failed or never-started answer comes back as a blank bubble with no way
  // to tell what happened.
  const stored = toStoredChat({
    turns: [turn(), turn({ id: "t2", role: "assistant", content: "" })],
  });
  assert.equal(stored.turns.length, 1, "only the turn with content survives");
});

test("an interrupted answer is marked as interrupted", () => {
  // Half an answer read later looks like the model trailed off. Saying so turns
  // that into a recorded decision.
  const stored = toStoredChat({
    turns: [turn({ id: "t2", role: "assistant", content: "分三个", phase: "cancelled" })],
  });
  assert.equal(stored.turns[0].phase, "cancelled");
});

test("a completed answer carries no phase marker", () => {
  // Keeping "completed" on every turn would be noise in a file people may read.
  const stored = toStoredChat({ turns: [turn({ id: "t2", role: "assistant", content: "答" })] });
  assert.equal(stored.turns[0].phase, undefined);
});

// ------------------------------------------------------------------ tolerance

test("a missing timestamp reads as unknown, not as 1970", () => {
  // A 1970 date looks like a real time from a broken clock; "unknown" is honest
  // and the UI shows nothing.
  const back = fromStoredChat({ version: 1, turns: [{ id: "t", role: "user", content: "x", createdAt: "" }] });
  assert.equal(back[0].createdAt, 0);
  assert.equal(formatTurnTime(back[0].createdAt), "", "and renders as nothing");
});

test("garbage turns are skipped instead of throwing", () => {
  // The file may be older than the build, hand-edited, or half-written. Losing
  // one turn is recoverable; refusing to open the conversation is not.
  const back = fromStoredChat({
    version: 1,
    turns: [
      { id: "a", role: "user", content: "保留", createdAt: "2026-10-18T11:00:00.000Z" },
      { id: "b", role: "system", content: "丢掉" },
      null,
      { id: "c", role: "assistant" },
    ],
  });
  assert.equal(back.length, 2, "system and null drop out; the two real turns stay");
  assert.equal(back[0].content, "保留");
  assert.equal(back[1].content, "", "a turn with no content field is empty, not a crash");
  assert.equal(back[1].role, "assistant");
});

test("a null document reads as no turns", () => {
  assert.deepEqual(fromStoredChat(null), []);
  assert.deepEqual(fromStoredChat(undefined), []);
  assert.deepEqual(fromStoredChat({ version: 1 }), []);
});

test("an image reference with no bytes is dropped", () => {
  // Rust drops attachments whose file is gone, leaving no dataUrl. A thumbnail
  // with no source renders as a broken box next to a question about it.
  const back = fromStoredChat({
    version: 1,
    turns: [
      {
        id: "t",
        role: "user",
        content: "看图",
        createdAt: "2026-10-18T11:00:00.000Z",
        attachments: [{ file: "abc.jpg", page: 3 }],
      },
    ],
  });
  assert.equal(back[0].attachments, undefined, "no phantom attachment");
  assert.equal(back[0].content, "看图", "the text is still there");
});

// --------------------------------------------------------------------- wire

test("a restored turn with images becomes a block array", () => {
  // Same rule as the live path. Without this, a follow-up on a restored
  // conversation would be answered about a paper the model cannot see.
  const msg = turnToMessage({
    id: "t",
    role: "user",
    content: "这个公式",
    phase: "completed",
    createdAt: 1,
    attachments: [
      { id: "a", url: "data:image/png;base64,AAA", chars: 10, width: 1, height: 1, source: "page", page: 2 },
    ],
  });
  assert.ok(Array.isArray(msg.content));
  assert.equal(msg.content[0].type, "text");
  assert.equal(msg.content[1].type, "image_url");
});

test("a restored text-only turn stays a string", () => {
  // The cache invariant: a text-only question must remain a string so the
  // document message ahead of it is the only thing that has to match.
  const msg = turnToMessage({ id: "t", role: "user", content: "x", phase: "completed", createdAt: 1 });
  assert.equal(typeof msg.content, "string");
});

// ------------------------------------------------------------- save decision

test("only terminal turns are worth saving", () => {
  // Saving mid-stream stores a truncated answer, which reads later as the model
  // having trailed off.
  assert.equal(isTerminalPhase("preparing"), false);
  assert.equal(isTerminalPhase("streaming"), false);
  assert.equal(isTerminalPhase("cancelling"), false);
  assert.equal(isTerminalPhase("completed"), true);
  assert.equal(isTerminalPhase("cancelled"), true);
  assert.equal(isTerminalPhase("error"), true);
});

// ------------------------------------------------------------------ display

test("the displayed time is local and zero-padded", () => {
  const ms = Date.parse("2026-10-18T11:35:12.000Z");
  const text = formatTurnTime(ms);
  assert.match(text, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, text);
  // Local, not the stored UTC offset: the user reads their own conversation on
  // their own machine, and a timestamp in another timezone is a puzzle.
  const d = new Date(ms);
  assert.ok(text.includes(String(d.getHours()).padStart(2, "0")), text);
});

test("an unusable time renders as nothing rather than a placeholder", () => {
  assert.equal(formatTurnTime(undefined), "");
  assert.equal(formatTurnTime(Number.NaN), "");
  assert.equal(formatTurnTime(0), "");
});
