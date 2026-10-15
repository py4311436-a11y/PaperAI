/**
 * Floating action bar over a PDF text selection.
 *
 * The one non-obvious requirement: **the bar must not steal the selection.**
 * Clicking a normal button moves focus, which collapses the DOM selection, and
 * by the time the click handler runs `window.getSelection()` is empty. Both
 * `pointerdown` and `mousedown` are therefore cancelled on every control, so
 * the selection is still live when the action fires.
 *
 * The bar also stays out of the way while drawing: it is hidden whenever the
 * tool is not `select`.
 */

import { keepSelectionAlive } from "./selection-snapshot";

export interface SelectionBarActions {
  onHighlight: () => void;
  onExplain: () => void;
  onTranslate: () => void;
  onCopy: () => void;
}

export class SelectionBar {
  private el: HTMLElement;
  private visible = false;
  /** Set while a drag is in progress, so the bar does not chase the cursor. */
  private suppressed = false;

  constructor(
    private host: HTMLElement,
    private actions: SelectionBarActions
  ) {
    this.el = document.createElement("div");
    this.el.id = "selection-bar";
    this.el.setAttribute("role", "toolbar");
    this.el.setAttribute("aria-label", "选中文字操作");
    this.el.hidden = true;

    const mk = (label: string, id: string, primary = false) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.dataset.act = id;
      if (primary) b.classList.add("primary");
      // THE critical line: without this the selection is gone before onclick.
      keepSelectionAlive(b);
      return b;
    };

    const hl = mk("高亮", "highlight");
    const ex = mk("解释", "explain", true);
    const tr = mk("翻译", "translate");
    const cp = mk("复制", "copy");
    this.el.append(hl, ex, tr, cp);

    this.el.addEventListener("click", (e) => {
      const act = (e.target as HTMLElement)?.dataset?.act;
      if (!act) return;
      e.preventDefault();
      // Re-read the selection *here*: it is still alive thanks to the
      // pointerdown guard, and this is the freshest possible moment.
      const text = window.getSelection()?.toString() ?? "";
      switch (act) {
        case "highlight":
          this.actions.onHighlight();
          break;
        case "explain":
          this.actions.onExplain();
          break;
        case "translate":
          this.actions.onTranslate();
          break;
        case "copy":
          void this.copySelection(text);
          break;
      }
    });

    host.appendChild(this.el);
  }

  private async copySelection(text: string): Promise<void> {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      this.flash("已复制");
    } catch {
      // Clipboard can be refused depending on focus; say so instead of lying.
      this.flash("复制失败");
    }
  }

  private flash(msg: string): void {
    const t = this.el.querySelector("[data-role=flash]") as HTMLElement | null;
    if (t) {
      t.textContent = msg;
      return;
    }
    const span = document.createElement("span");
    span.dataset.role = "flash";
    span.className = "sb-flash";
    span.textContent = msg;
    this.el.appendChild(span);
    setTimeout(() => span.remove(), 1200);
  }

  /** Hide while the user is dragging out a selection. */
  setSuppressed(v: boolean): void {
    this.suppressed = v;
    if (v) this.hide();
  }

  showAt(rect: DOMRect, canExplain: boolean): void {
    if (this.suppressed) return;
    this.el.hidden = false;
    this.visible = true;
    for (const b of Array.from(this.el.querySelectorAll("button"))) {
      const act = (b as HTMLElement).dataset.act;
      // Explain/Translate need real text; Highlight too.
      if (act === "explain" || act === "translate" || act === "highlight") {
        b.toggleAttribute("disabled", !canExplain);
      }
    }

    // Position above the selection, clamped to the host box.
    const hostRect = this.host.getBoundingClientRect();
    this.el.style.visibility = "hidden";
    const bar = this.el.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - bar.width / 2 - hostRect.left;
    let top = rect.top - bar.height - 10 - hostRect.top;
    if (top < 4) top = rect.bottom + 10 - hostRect.top;
    left = Math.max(6, Math.min(left, hostRect.width - bar.width - 6));
    this.el.style.left = `${left}px`;
    this.el.style.top = `${top}px`;
    this.el.style.visibility = "";
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.el.hidden = true;
  }

  isVisible(): boolean {
    return this.visible;
  }
}
