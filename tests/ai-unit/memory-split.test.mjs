/**
 * Splitting a memory file into its summary and its exchange log.
 *
 * The reason this exists: regenerating the notes replaces the file, and the log
 * of what the reader asked and was told is theirs. The summary cannot simply be
 * "everything before the log" by heading level, because the summary itself uses
 * `### ` for its per-chunk notes — so the log needs a heading of its own.
 *
 * Run via `node scripts/run-ai-unit-tests.mjs`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  mergeMemoryBody,
  QA_SECTION_HEADING,
  splitMemoryBody,
} from "../../dist-test/src/ai/memory.js";

const SUMMARY = [
  "# 阅读笔记：某论文",
  "",
  "- 更新时间：2026-10-20 12:00",
  "",
  "## 全文概要",
  "",
  "这是概要。",
  "",
  "## 分段要点",
  "",
  "### 第 1–3 页",
  "",
  "第一段要点。",
  "",
  "### 第 4–7 页",
  "",
  "第二段要点。",
  "",
].join("\n");

test("a file with no log splits into an all-summary result", () => {
  const { summary, qa } = splitMemoryBody(SUMMARY);
  assert.equal(qa, "");
  assert.ok(summary.includes("第二段要点"), "the per-chunk notes must stay in the summary");
});

test("the per-chunk notes are not mistaken for the log", () => {
  // The bug this guards: splitting on `### ` would sweep "### 第 1–3 页" into
  // the log, and regenerating would then delete the chunk notes.
  const { qa } = splitMemoryBody(SUMMARY);
  assert.equal(qa, "");
  assert.ok(!qa.includes("第 1–3 页"));
});

test("a marked log is separated from the summary", () => {
  const body = `${SUMMARY}\n${QA_SECTION_HEADING}\n\n### 2026-10-20 15:06 · 这是什么\n\n**答：** 某个回答\n`;
  const { summary, qa } = splitMemoryBody(body);
  assert.ok(summary.includes("第二段要点"));
  assert.ok(!summary.includes(QA_SECTION_HEADING));
  assert.ok(qa.startsWith(QA_SECTION_HEADING), qa.slice(0, 40));
  assert.ok(qa.includes("某个回答"));
});

test("a legacy log is recognised by its dated headings", () => {
  // Files written before the marker existed have dated headings at the end.
  const legacy = `${SUMMARY}\n### 2026-10-19 11:20 · 旧问题\n\n**答：** 旧回答\n`;
  const { summary, qa } = splitMemoryBody(legacy);
  assert.ok(summary.includes("第二段要点"));
  assert.ok(qa.includes("旧回答"));
  assert.ok(!summary.includes("旧回答"));
});

test("a legacy log does not swallow the chunk notes that precede it", () => {
  const { summary, qa } = splitMemoryBody(
    `${SUMMARY}\n### 2026-10-19 11:20 · 旧问题\n\n**答：** 旧回答\n`
  );
  assert.ok(summary.includes("第一段要点"));
  assert.ok(summary.includes("第二段要点"));
  assert.ok(!summary.includes("旧回答"));
});

test("a file that is only a log still splits", () => {
  const { summary, qa } = splitMemoryBody(`${QA_SECTION_HEADING}\n\n### 2026-10-20 15:06 · x\n\n**答：** y\n`);
  assert.equal(summary, "");
  assert.ok(qa.includes("**答：** y"));
});

test("merging puts the log back under the new summary", () => {
  const merged = mergeMemoryBody("# 新概要\n\n内容。", `${QA_SECTION_HEADING}\n\n### x\n\n**答：** y\n`);
  assert.ok(merged.includes("# 新概要"));
  assert.ok(merged.includes(QA_SECTION_HEADING));
  assert.ok(merged.indexOf("新概要") < merged.indexOf(QA_SECTION_HEADING), "the log goes last");
});

test("merging with an empty log leaves just the summary", () => {
  const merged = mergeMemoryBody("# 新概要", "");
  assert.equal(merged, "# 新概要");
});

test("a summary-and-log round trip keeps the log intact", () => {
  // The property that matters end to end: regenerate, and nothing of the log
  // is lost.
  const original = `${SUMMARY}\n${QA_SECTION_HEADING}\n\n### 2026-10-20 15:06 · 问题\n\n**答：** 回答\n`;
  const { summary, qa } = splitMemoryBody(original);
  const regenerated = mergeMemoryBody("# 重新生成的概要\n\n新的内容。", qa);
  const after = splitMemoryBody(regenerated);
  assert.ok(after.qa.includes("**答：** 回答"), after.qa);
  assert.ok(after.summary.includes("重新生成的概要"));
  assert.ok(!after.summary.includes("回答"), "the old summary must not come back");
});
