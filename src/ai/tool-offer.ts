/**
 * Which tools to offer, and what to tell the model it already has.
 *
 * A model that does not know what it is holding will fetch it again — and in
 * the whole-document image mode it was being invited to do exactly that: every
 * page was already in the request as an image, at the same resolution
 * `read_page` would produce, and the model set about fetching all nine pages
 * one by one to "verify" a document it was already holding.
 *
 * The decision is a pure function of the context mode, so it can be tested
 * without a document, a provider or a window.
 */

import type { ContextMode } from "./types";

/**
 * Whether the page-reading tool is offered at all.
 *
 * Not in the whole-document image mode: the pages are already sent, as images.
 * A tool that is not offered cannot be called, so this is a design fix rather
 * than a matter of asking the model politely.
 */
export function pageToolOffered(mode: ContextMode): boolean {
  return mode !== "whole-document-images";
}

/**
 * What the model is already holding, in the words it needs.
 *
 * In the text mode the document's text is already sent, so the page tool is
 * for the figures and formulas that text cannot carry. Saying so is the
 * difference between the model reading the figures it needs and the model
 * reading every page.
 */
export function whatTheModelAlreadyHas(mode: ContextMode): string {
  switch (mode) {
    case "whole-document":
      return "本文档的文字已经发给你了；read_page 用来取某一页的图像（图表、公式、排版）。";
    case "nearby-pages":
      return "附近几页的内容已经发给你了；read_page 用来取更远的页面。";
    case "selection":
      return "你选中的内容已经发给你了；read_page 用来取其他页面。";
    default:
      return "";
  }
}
