/**
 * Markdown + LaTeX renderer that builds **DOM nodes**, never HTML strings.
 *
 * Why not a markdown library: every one of them produces an HTML string that we
 * would then have to sanitise correctly, and a single mistake in that sanitiser
 * is an XSS. Here, model output is only ever assigned via `textContent`, so
 * there is no parsing step for an attacker to subvert. Anything the model emits
 * that looks like `<script>` is displayed as the literal text `<script>`.
 *
 * Supported: headings, bold/italic/inline code, fenced and indented code,
 * blockquotes, ordered/unordered lists, horizontal rules, links (rendered as
 * inert text plus an explicit user action), and LaTeX via KaTeX.
 *
 * Explicitly unsupported and *inert*: raw HTML, images (never fetched — a
 * remote image is a tracking beacon), iframes, and `javascript:`/`data:` URLs.
 */

import katex from "katex";
// NOTE: KaTeX's stylesheet is imported by the app entry (src/main.ts), not here.
// Keeping this module free of CSS imports lets the unit tests load it directly
// in Node, where a `.css` import cannot be resolved.

export interface RenderOptions {
  /**
   * Called when the user explicitly clicks a link. Never called during render:
   * rendering must not be able to trigger a network request.
   */
  onOpenLink?: (url: string) => void;
  /** Disable KaTeX for tests that only care about text. */
  math?: boolean;
}

/** Only these schemes are ever offered as a clickable link. */
function isSafeLink(url: string): boolean {
  const u = url.trim().toLowerCase();
  return u.startsWith("https://") || u.startsWith("http://");
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

/**
 * Render LaTeX with KaTeX, falling back to literal text on error.
 *
 * `throwOnError: false` keeps a malformed formula from breaking the message;
 * `trust: false` and `strict: "ignore"` keep KaTeX from emitting anything
 * active (it never emits HTML for `\href` unless trusted).
 */
function renderMath(tex: string, displayMode: boolean, into: HTMLElement, enable: boolean): void {
  if (!enable) {
    into.textContent = displayMode ? `$$${tex}$$` : `$${tex}$`;
    return;
  }
  try {
    katex.render(tex, into, {
      displayMode,
      throwOnError: false,
      trust: false,
      strict: "ignore",
      output: "html",
    });
  } catch {
    into.textContent = displayMode ? `$$${tex}$$` : `$${tex}$`;
  }
}

/** Parse inline markup into a fragment. No HTML ever enters. */
function inline(text: string, opts: RenderOptions): DocumentFragment {
  const frag = document.createDocumentFragment();

  // Walk the string once, handling math first, then inline code, then
  // emphasis. A token stream is simpler to get right than nested regexes.
  let i = 0;
  const push = (n: Node) => frag.appendChild(n);
  const pushText = (s: string) => {
    if (s) push(document.createTextNode(s));
  };

  while (i < text.length) {
    // --- inline display math: $$...$$ on a single line ---
    //
    // Checked BEFORE the single-`$` branch on purpose. Without this, `$$x$$`
    // fell through to the inline rule, which matched the inner `$x$` and left
    // the outer pair behind as literal "$x$" — a display formula silently
    // demoted to inline text with stray dollar signs.
    if (text.startsWith("$$", i)) {
      const end = text.indexOf("$$", i + 2);
      if (end > i + 2) {
        const span = el("span", "md-math-inline md-math-display");
        renderMath(text.slice(i + 2, end), true, span, opts.math !== false);
        push(span);
        i = end + 2;
        continue;
      }
    }

    // --- inline math: $...$ or \(...\) ---
    if (text[i] === "$" && text[i + 1] !== "$") {
      const end = text.indexOf("$", i + 1);
      if (end > i + 1) {
        const span = el("span", "md-math-inline");
        renderMath(text.slice(i + 1, end), false, span, opts.math !== false);
        push(span);
        i = end + 1;
        continue;
      }
    }
    if (text.startsWith("\\(", i)) {
      const end = text.indexOf("\\)", i + 2);
      if (end > i + 2) {
        const span = el("span", "md-math-inline");
        renderMath(text.slice(i + 2, end), false, span, opts.math !== false);
        push(span);
        i = end + 2;
        continue;
      }
    }
    // --- inline display math: \[...\] ---
    // Models that were trained on LaTeX documents (and most Chinese ones are)
    // reach for `\[...\]` for display math. We only understood `$$` and
    // `\(...\)`, so those formulas rendered as raw `\[ \varepsilon \frac` text.
    if (text.startsWith("\\[", i)) {
      const end = text.indexOf("\\]", i + 2);
      if (end > i + 2) {
        const span = el("span", "md-math-inline md-math-display");
        renderMath(text.slice(i + 2, end), true, span, opts.math !== false);
        push(span);
        i = end + 2;
        continue;
      }
    }

    // --- inline code ---
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i + 1) {
        push(el("code", "md-code-inline", text.slice(i + 1, end)));
        i = end + 1;
        continue;
      }
    }

    // --- bold / italic ---
    if (text.startsWith("**", i)) {
      const end = text.indexOf("**", i + 2);
      if (end > i) {
        const b = el("strong");
        b.appendChild(inline(text.slice(i + 2, end), opts));
        push(b);
        i = end + 2;
        continue;
      }
    }
    if (text[i] === "*" && text[i + 1] !== "*") {
      const end = text.indexOf("*", i + 1);
      if (end > i + 1) {
        const em = el("em");
        em.appendChild(inline(text.slice(i + 1, end), opts));
        push(em);
        i = end + 1;
        continue;
      }
    }

    // --- image: ![alt](url) -----------------------------------------------
    // Handled BEFORE the link branch. Images are never loaded (a remote image
    // is a tracking beacon), so we render an explicit, honest placeholder
    // instead of quietly turning it into a clickable link labelled with the
    // alt text — which would be a different thing from what the model wrote.
    if (text[i] === "!" && text[i + 1] === "[") {
      const parsed = parseLinkAt(text, i + 1);
      if (parsed) {
        const alt = parsed.label || "图片";
        const span = el("span", "md-image-omitted");
        span.textContent = `[图片未加载：${alt}]`;
        if (parsed.url) {
          const u = el("span", "md-image-url", ` ${parsed.url}`);
          span.appendChild(u);
        }
        push(span);
        i = parsed.end;
        continue;
      }
    }

    // --- link: [label](url) ---
    if (text[i] === "[") {
      const parsed = parseLinkAt(text, i);
      if (parsed) {
        if (isSafeLink(parsed.url)) {
          // A real <a>, but with no href: rendering can never navigate, and the
          // URL only opens on an explicit click.
          const a = el("a", "md-link", parsed.label || parsed.url);
          a.dataset.url = parsed.url;
          a.setAttribute("role", "link");
          a.tabIndex = 0;
          push(a);
        } else {
          // Inert: shown as text so the user can see what was attempted.
          push(
            el(
              "span",
              "md-link-blocked",
              parsed.label ? `${parsed.label}（链接已禁用：${parsed.url}）` : `链接已禁用：${parsed.url}`
            )
          );
        }
        i = parsed.end;
        continue;
      }
    }

    // --- plain character ---
    // Consume a run of characters that cannot start any construct.
    const next = findNextSpecial(text, i + 1);
    pushText(text.slice(i, next));
    i = next;
  }

  return frag;
}

function findNextSpecial(s: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (c === "$" || c === "`" || c === "*" || c === "[" || c === "!" || c === "\\") return i;
  }
  return s.length;
}

interface ParsedLink {
  label: string;
  url: string;
  /** Index just past the closing parenthesis. */
  end: number;
}

/**
 * Parse `[label](url)` starting at `start` (the index of `[`).
 *
 * Parentheses inside the URL are balanced rather than truncated at the first
 * `)`, so real links like
 * `https://en.wikipedia.org/wiki/Foo_(bar)` survive intact. Returns null when
 * the shape is not a link, in which case the `[` is just text.
 */
function parseLinkAt(text: string, start: number): ParsedLink | null {
  if (text[start] !== "[") return null;
  const close = text.indexOf("](", start);
  if (close < 0) return null;

  const label = text.slice(start + 1, close);
  let i = close + 2;
  let depth = 0;
  let url = "";
  while (i < text.length) {
    const c = text[i];
    if (c === "(") {
      depth++;
      url += c;
    } else if (c === ")") {
      if (depth === 0) return { label, url: url.trim(), end: i + 1 };
      depth--;
      url += c;
    } else if (c === "\n") {
      // A link may not span lines; treat as malformed.
      return null;
    } else {
      url += c;
    }
    i++;
  }
  return null; // unterminated
}

/**
 * Render a markdown document into `container`.
 * `container` is cleared first; its children are rebuilt from scratch.
 */
export function renderMarkdown(
  container: HTMLElement,
  source: string,
  opts: RenderOptions = {}
): void {
  container.textContent = "";
  container.classList.add("md-body");

  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;

  const flushParagraph = (buf: string[]) => {
    if (!buf.length) return;
    const p = el("p");
    p.appendChild(inline(buf.join(" "), opts));
    container.appendChild(p);
    buf.length = 0;
  };

  const para: string[] = [];

  while (i < lines.length) {
    const line = lines[i];

    // --- fenced code block ---
    const fence = line.match(/^\s*(```+|~~~+)\s*([\w+-]*)\s*$/);
    if (fence) {
      flushParagraph(para);
      const marker = fence[1][0];
      const lang = fence[2] || "";
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${marker}{3,}\\s*$`).test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // consume closing fence (or run off the end)
      const pre = el("pre", "md-code-block");
      if (lang) pre.dataset.lang = lang;
      // textContent: a code block is inert text, never markup.
      pre.appendChild(el("code", undefined, body.join("\n")));
      container.appendChild(pre);
      continue;
    }

    // --- block math: $$...$$ or \[...\] ---
    //
    // `\[ ... \]` is handled alongside `$$ ... $$` because that is what models
    // actually emit for a formula on its own line. Only recognising `$$` left
    // the raw `\[` and `\]` markers visible in the transcript.
    const blockMathDelims: Array<[string, string]> = [
      ["$$", "$$"],
      ["\\[", "\\]"],
    ];
    const trimmed = line.trim();
    const mathDelim = blockMathDelims.find(
      ([open]) => trimmed.startsWith(open) && !(open === "$$" && trimmed === "$$$")
    );
    if (mathDelim) {
      flushParagraph(para);
      const [open, close] = mathDelim;
      const oneLine = trimmed.match(
        open === "$$" ? /^\$\$(.+)\$\$$/ : /^\\\[(.+)\\\]$/
      );
      if (oneLine) {
        const div = el("div", "md-math-block");
        renderMath(oneLine[1], true, div, opts.math !== false);
        container.appendChild(div);
        i++;
        continue;
      }
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().endsWith(close)) {
        body.push(lines[i]);
        i++;
      }
      if (i < lines.length) {
        body.push(lines[i].trim().slice(0, lines[i].trim().length - close.length));
        i++;
      }
      const div = el("div", "md-math-block");
      renderMath(body.join("\n"), true, div, opts.math !== false);
      container.appendChild(div);
      continue;
    }

    // --- horizontal rule ---
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      flushParagraph(para);
      container.appendChild(el("hr"));
      i++;
      continue;
    }

    // --- heading ---
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushParagraph(para);
      const level = Math.min(h[1].length + 2, 6); // keep h1..h3 inside a panel
      const node = el(`h${level}` as "h3");
      node.appendChild(inline(h[2], opts));
      container.appendChild(node);
      i++;
      continue;
    }

    // --- blockquote ---
    if (/^\s*>\s?/.test(line)) {
      flushParagraph(para);
      const body: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        body.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      const bq = el("blockquote");
      const p = el("p");
      p.appendChild(inline(body.join(" "), opts));
      bq.appendChild(p);
      container.appendChild(bq);
      continue;
    }

    // --- list (ordered or unordered) ---
    const li = line.match(/^\s*([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      flushParagraph(para);
      const ordered = /\d/.test(li[1]);
      const list = el(ordered ? "ol" : "ul");
      while (i < lines.length) {
        const m = lines[i].match(/^\s*([-*+]|\d+[.)])\s+(.*)$/);
        if (!m) break;
        const item = el("li");
        item.appendChild(inline(m[2], opts));
        list.appendChild(item);
        i++;
      }
      container.appendChild(list);
      continue;
    }

    // --- blank line ends a paragraph ---
    if (!line.trim()) {
      flushParagraph(para);
      i++;
      continue;
    }

    para.push(line.trim());
    i++;
  }
  flushParagraph(para);

  // Wire the explicit-click behaviour exactly once per container.
  if (!container.dataset.linkWired) {
    container.dataset.linkWired = "1";
    container.addEventListener("click", (e) => {
      const a = (e.target as HTMLElement)?.closest?.(".md-link") as HTMLElement | null;
      if (!a?.dataset.url) return;
      e.preventDefault();
      opts.onOpenLink?.(a.dataset.url);
    });
  }
}

/** Plain text of rendered markdown, for the copy button and for tests. */
export function renderedText(container: HTMLElement): string {
  return container.textContent ?? "";
}
