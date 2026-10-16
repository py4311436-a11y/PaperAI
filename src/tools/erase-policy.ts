/**
 * When an armed erase may delete something.
 *
 * Extracted as a pure function on purpose. The behaviour it encodes is the
 * whole difference between an eraser and a "delete whatever was selected"
 * button, and the reported bug was exactly that confusion: pressing Erase after
 * drawing a stroke removed *that stroke* (PDF.js keeps a freshly drawn editor
 * selected), so the tool felt like it was deleting a previous action instead of
 * the thing under the cursor.
 *
 * The rules, in order:
 *  1. not armed                -> ignore. A click with the tool off must never
 *                                 delete anything.
 *  2. click missed every editor-> ignore. Empty paper must never delete, even
 *                                 when something is selected from earlier.
 *  3. click hit an editor but PDF.js has not selected anything yet -> ignore.
 *                                 (The selection lands on the editor's own
 *                                 pointer handling, which may run after ours.)
 *  4. otherwise                -> delete, i.e. the one the user aimed at.
 *
 * Rule 2 is what makes "click where you want to erase" true. Rule 1 is what
 * makes arming the tool harmless: the click on the Erase *button* can never
 * delete, no matter what was selected before it.
 */

export interface EraseInput {
  /** The user has armed the eraser. */
  armed: boolean;
  /** A DOM hit test says the pointer landed on an annotation editor. */
  hitAnnotation: boolean;
  /** PDF.js reports an annotation selected. */
  hasSelection: boolean;
}

export type EraseDecision = "delete" | "ignore";

export function eraseDecision(input: EraseInput): EraseDecision {
  if (!input.armed) return "ignore";
  if (!input.hitAnnotation) return "ignore";
  return input.hasSelection ? "delete" : "ignore";
}