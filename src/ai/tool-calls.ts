/**
 * Deciding what to do with a model's tool calls.
 *
 * Pure, and separated from the app for one reason: this is the only place a
 * model can make the app *do* something, so every rule here needs a test that
 * fails when the rule is removed. The rendering, the progress UI and the
 * approval prompt stay in `main.ts`; what is decided stays here.
 *
 * The rules, and why each is a refusal rather than a repair:
 *
 *  - **Unknown names are refused.** Only `read_page` exists, and Rust checks the
 *    same allowlist. A tool is an action; a name that arrived from somewhere
 *    else must not become one.
 *  - **The page must be an integer in range.** Clamping a request for page 900
 *    of a 7-page paper would return page 7 and the model would answer from it
 *    believing it had page 900. A refusal lets it say what it could not read.
 *  - **Each call gets exactly one reply.** The protocol requires it, and a
 *    missing reply makes the request malformed — which the provider reports as a
 *    bad request, looking like a broken model rather than a broken app.
 *  - **The budget is counted in distinct pages fetched, not in calls.** Otherwise
 *    asking twice for page 5 buys two refetches.
 */

import type { ToolCall } from "./types";

/**
 * Refetch budget per question, in distinct pages.
 *
 * Two was too small for the questions this app exists for: "check the notes
 * against the original, and by the way how would you do X" wants the whole
 * paper, and a two-page budget stopped the model half way through with a
 * half-answer.
 *
 * The ceiling is the same as the one the whole-document image mode already
 * uses, so a question that reads pages on demand costs no more than the mode
 * that sends them all.
 */
export const MAX_REFETCH_PAGES = 12;

export interface ToolPlan {
  /** Pages to fetch, in the order the model asked, de-duplicated. */
  fetch: number[];
  /** Replies that need no work: refusals and already-paid-for pages. */
  replies: { id: string; reason: string }[];
  /** True when `fetch` would exceed the budget. */
  overBudget: boolean;
  /** Pages in `fetch` that are not already fetched. */
  fresh: number[];
}

/**
 * Read the `page` argument, or say why it is unusable.
 *
 * Returns a number only for a JSON object with an integer `page`. A string
 * `"3"`, a float `3.7` and a missing field are all malformed calls, and each gets
 * a message the model can act on.
 */
function readPageArg(args: string): { page: number } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(args || "{}");
  } catch {
    return { error: '参数不是有效的 JSON。请用 {"page": 页码} 重新调用。' };
  }
  const page = (parsed as { page?: unknown } | null)?.page;
  if (typeof page !== "number" || !Number.isInteger(page)) {
    return { error: `页码必须是整数，收到的是 ${JSON.stringify(page)}。` };
  }
  return { page };
}

/**
 * Decide which pages to fetch and what to tell the model about the rest.
 *
 * `alreadyFetched` is the set of pages already pulled in for this question, so a
 * second round cannot charge the same page twice.
 */
export function planToolCalls(
  calls: ToolCall[],
  pageCount: number,
  /**
   * Pages already refetched for this question. These count against the budget.
   */
  alreadyFetched: ReadonlySet<number>,
  /**
   * Pages already in the request for another reason — the context mode sent
   * them. Repeated on purpose as a separate set: such a page costs nothing to
   * re-request, so it must be refused as a duplicate but must *not* consume the
   * refetch budget, or a whole-document image question would start out already
   * over budget and every call would prompt the user.
   */
  alreadyInRequest: ReadonlySet<number> = new Set()
): ToolPlan {
  const fetch: number[] = [];
  const replies: { id: string; reason: string }[] = [];

  for (const call of calls) {
    const name = call.function?.name ?? "";
    if (name !== "read_page") {
      // The note tools are handled elsewhere — they are not page fetches and
      // have their own rules. Reaching here means a tool nobody implements,
      // which must be refused by name rather than silently ignored.
      replies.push({ id: call.id, reason: `不支持的工具：${name}。` });
      continue;
    }
    const arg = readPageArg(call.function?.arguments ?? "");
    if ("error" in arg) {
      replies.push({ id: call.id, reason: arg.error });
      continue;
    }
    if (arg.page < 1 || arg.page > pageCount) {
      replies.push({
        id: call.id,
        reason: `页码 ${arg.page} 超出范围（本文件共 ${pageCount} 页）。`,
      });
      continue;
    }
    if (alreadyFetched.has(arg.page) || alreadyInRequest.has(arg.page)) {
      // Already in the request. Saying so is better than sending the same image
      // twice: the model stops asking and uses what it has.
      replies.push({ id: call.id, reason: `第 ${arg.page} 页的图像本次已经发送过了。` });
      continue;
    }
    if (!fetch.includes(arg.page)) fetch.push(arg.page);
  }

  const fresh = fetch.filter((p) => !alreadyFetched.has(p));
  return {
    fetch,
    replies,
    fresh,
    overBudget: alreadyFetched.size + fresh.length > MAX_REFETCH_PAGES,
  };
}

/**
 * The reply for a call that was answered with an image.
 *
 * Built here so the shape — an image inside a `tool` message — is tested in one
 * place rather than assembled by hand at the call site.
 */
export function imageToolReply(callId: string, page: number, dataUrl: string) {
  return {
    role: "tool" as const,
    tool_call_id: callId,
    content: [
      { type: "text" as const, text: `第 ${page} 页的图像如下。` },
      { type: "image_url" as const, image_url: { url: dataUrl } },
    ],
  };
}

/** The reply for a call that was refused. */
export function refusalReply(callId: string, reason: string) {
  return { role: "tool" as const, tool_call_id: callId, content: reason };
}
