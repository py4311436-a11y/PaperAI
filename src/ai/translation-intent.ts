/**
 * Whether a question is asking for a translation.
 *
 * The reader selects a region of a page and asks for it to be translated. What
 * they need then is the *words*, and the page's text layer has them exactly —
 * so the text is sent instead of the image. That is faster than a vision model
 * and cannot misread a glyph.
 *
 * The detection is deliberately a list of words rather than a model call: it
 * has to run before the request is built, and a second model call to decide
 * whether to make a model call is a poor trade.
 *
 * It is also deliberately narrow. Switching to text means the model cannot see
 * the figure, so a question that is only *partly* about translating — "explain
 * this figure and translate its caption" — should keep the image. The reader
 * can always switch by hand; the chip shows which is in use.
 */

/** Words that mean "translate this" and nothing else. */
const TRANSLATION_WORDS = [
  "翻译",
  "译成",
  "译为",
  "译文",
  "翻成",
  // "英文" on its own: the reader who selected an English region and wrote
  // "这句英文什么意思" is asking what it says. Matching on "英文意思" instead
  // would miss it, because the word 什么 sits in between.
  "英文",
  "中文意思",
  "translate",
  "translation",
];

/**
 * True when the question is asking for a translation.
 *
 * Matching is on whole words for the Latin script and on substrings for
 * Chinese, which has no word boundaries. Case is ignored.
 */
export function looksLikeTranslation(question: string): boolean {
  const q = (question ?? "").trim().toLowerCase();
  if (!q) return false;

  for (const w of TRANSLATION_WORDS) {
    const needle = w.toLowerCase();
    if (isLatin(needle)) {
      // Whole word, so "translated" still matches but "translater" does not,
      // and a word that merely contains it does not either.
      const re = new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      if (re.test(q)) return true;
    } else if (q.includes(needle)) {
      return true;
    }
  }
  return false;
}

function isLatin(s: string): boolean {
  const c = s.codePointAt(0) ?? 0;
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
}
