/**
 * Which models accept images.
 *
 * There is no honest way to know in advance. A provider's model catalogue
 * returns ids and nothing else — no capability field — so any static list of
 * "vision models" is a guess that goes stale and, worse, gives the user
 * confidence it has not earned. DeepSeek's own answer to sending an image to a
 * text-only model is a flat 400, which is at least unambiguous.
 *
 * So this module remembers instead of guessing: the first image question to a
 * text-only model fails with the provider's own message, that message is
 * recorded against the model, and every later attempt with that model is warned
 * before it is sent. A model that works is never warned about. The map is
 * per-process and starts empty, so it can only ever be right about models this
 * installation has actually tried.
 */

/** Process-lifetime record of "this model refused an image, and why". */
const failures = new Map<string, string>();

/**
 * Does this read like a refusal to accept images at all?
 *
 * Deliberately broad. It is only consulted for a request that *did* carry an
 * image and *did* fail, so a false positive costs one extra warning on an
 * unrelated error — while a false negative would mean never learning.
 */
export function looksLikeImageSupportError(message: string): boolean {
  return /image|vision|multimodal|图片|视觉|多模态|识图/i.test(message);
}

/** Record a refusal, so the next attempt with this model is warned first. */
export function noteImageFailure(model: string, message: string): void {
  const m = model.trim();
  if (m) failures.set(m, message);
}

/** The recorded refusal for this model, if any. */
export function imageFailureFor(model: string): string | null {
  return failures.get(model.trim()) ?? null;
}

/**
 * Forget a recorded refusal.
 *
 * Called when the user switches model and comes back, and available to settings
 * so a provider that adds vision support does not stay warned forever.
 */
export function forgetImageFailure(model: string): void {
  failures.delete(model.trim());
}

/** Test seam: drop everything recorded. */
export function resetImageFailures(): void {
  failures.clear();
}
