/**
 * Recognising "translate this" in a question.
 *
 * The consequence of a false positive is that the model cannot see the figure
 * the reader asked about; the consequence of a false negative is that a
 * translation is done from a picture instead of from exact text. The second is
 * the cheaper mistake, so the list is narrow.
 *
 * Run via `node scripts/run-ai-unit-tests.mjs`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { looksLikeTranslation } from "../../dist-test/src/ai/translation-intent.js";

test("a plain translation request is recognised", () => {
  for (const q of ["翻译一下", "翻译", "帮我译成中文", "译文", "翻成中文"]) {
    assert.equal(looksLikeTranslation(q), true, q);
  }
});

test("an English translation request is recognised", () => {
  for (const q of ["translate this", "Translate it", "translation please", "TRANSLATE"]) {
    assert.equal(looksLikeTranslation(q), true, q);
  }
});

test("a question about meaning in the other language is recognised", () => {
  assert.equal(looksLikeTranslation("这句英文什么意思"), true);
  assert.equal(looksLikeTranslation("英文怎么说"), true);
});

test("an unrelated question is not a translation request", () => {
  for (const q of [
    "这个图怎么读",
    "作者用了什么方法",
    "为什么这里会收敛",
    "summarise the method",
    "what does this figure show",
    "",
  ]) {
    assert.equal(looksLikeTranslation(q), false, q);
  }
});

test("a word merely containing a keyword is not a translation request", () => {
  // "translater" is not "translate", and a paper about translation studies is
  // not a translation request.
  assert.equal(looksLikeTranslation("what is a translater"), false);
  assert.equal(looksLikeTranslation("the translateral distance"), false);
});
