/**
 * Region selection over the PDF viewer.
 *
 * Split into a pure part and a DOM part on purpose. The rectangle maths — clamp
 * a drag into the container, map container coordinates into a page canvas's
 * pixel coordinates — is where the off-by-one-scroll bugs live, and those are
 * only catchable if the maths can be exercised without a browser.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Rect extends Size {
  x: number;
  y: number;
}

/**
 * A rectangle in client (viewport) coordinates.
 *
 * Deliberately not container-local. The overlay has to be mounted on a
 * non-scrolling ancestor — `#viewerContainer` scrolls, and an `inset: 0` child
 * of a scrolling box is positioned against the top of the *content*, so it
 * sails out of view the moment the user scrolls. Returning client coordinates
 * means the caller never has to know which element that was, and the mapping
 * into a page canvas is one subtraction either way.
 */
export interface ClientRect extends Size {
  left: number;
  top: number;
}

/**
 * Turn a drag into a rect inside `bounds`.
 *
 * Returns null when the drag is smaller than `minSide` on either axis: a
 * three-pixel selection is a mis-click, and capturing it produces an image of
 * nothing that the user then has to notice and delete.
 */
export function normaliseRect(
  from: Point,
  to: Point,
  bounds: Size,
  minSide = 8
): Rect | null {
  const x1 = Math.min(from.x, to.x);
  const y1 = Math.min(from.y, to.y);
  const x2 = Math.max(from.x, to.x);
  const y2 = Math.max(from.y, to.y);

  const left = Math.max(0, Math.min(x1, bounds.width));
  const top = Math.max(0, Math.min(y1, bounds.height));
  const right = Math.max(0, Math.min(x2, bounds.width));
  const bottom = Math.max(0, Math.min(y2, bounds.height));

  const width = right - left;
  const height = bottom - top;
  if (width < minSide || height < minSide) return null;
  return { x: left, y: top, width, height };
}

/**
 * Map a client-coordinate rect into a page canvas's pixel coordinates.
 *
 * `pageLeft` / `pageTop` are the canvas's own client position, and `scale` is
 * `canvas.width / canvas.getBoundingClientRect().width` — CSS pixels to device
 * pixels. The scale is where the zoom case lives: a page displayed at 50% has a
 * canvas twice as wide as its CSS box, and capturing without that factor
 * returns the right area at double size, i.e. half the content the user pointed
 * at.
 */
export function toCanvasRect(
  rect: ClientRect,
  pageLeft: number,
  pageTop: number,
  scale: number
): Rect {
  return {
    x: (rect.left - pageLeft) * scale,
    y: (rect.top - pageTop) * scale,
    width: rect.width * scale,
    height: rect.height * scale,
  };
}

/**
 * The overlay itself.
 *
 * One instance per arming. It never outlives a selection: `arm()` creates the
 * DOM, a selection or a cancel removes it again. Leftover overlays are how a
 * viewer ends up swallowing clicks after the user has moved on.
 */
export class ScreenshotOverlay {
  private el: HTMLDivElement | null = null;
  private box: HTMLDivElement | null = null;
  private start: Point | null = null;

  constructor(
    private container: HTMLElement,
    private onDone: (rect: ClientRect | null) => void
  ) {}

  /** True while a selection is in progress. */
  get armed(): boolean {
    return this.el !== null;
  }

  arm(): void {
    if (this.el) return;
    const el = document.createElement("div");
    el.className = "ai-shot-overlay";
    // The viewer's own scrolling must keep working, so the overlay is a sibling
    // layer rather than a replacement for the page.
    el.addEventListener("pointerdown", this.onDown);
    window.addEventListener("pointermove", this.onMove);
    window.addEventListener("pointerup", this.onUp);
    window.addEventListener("keydown", this.onKey, true);
    this.container.appendChild(el);
    this.el = el;
  }

  private onDown = (e: PointerEvent): void => {
    e.preventDefault();
    const b = this.container.getBoundingClientRect();
    this.start = { x: e.clientX - b.left, y: e.clientY - b.top };
    if (!this.box) {
      const box = document.createElement("div");
      box.className = "ai-shot-box";
      this.el?.appendChild(box);
      this.box = box;
    }
    this.paint(this.start, this.start, b);
  };

  private onMove = (e: PointerEvent): void => {
    if (!this.start || !this.box) return;
    const b = this.container.getBoundingClientRect();
    this.paint(this.start, { x: e.clientX - b.left, y: e.clientY - b.top }, b);
  };

  private onUp = (e: PointerEvent): void => {
    if (!this.start) return;
    const b = this.container.getBoundingClientRect();
    const local = normaliseRect(
      this.start,
      { x: e.clientX - b.left, y: e.clientY - b.top },
      { width: b.width, height: b.height }
    );
    // Converted here, while the container's box is still known, so the caller
    // receives viewport coordinates and never has to know the mount point.
    const rect: ClientRect | null = local
      ? { left: b.left + local.x, top: b.top + local.y, width: local.width, height: local.height }
      : null;
    this.finish(rect);
  };

  private onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.finish(null);
    }
  };

  private paint(from: Point, to: Point, bounds: DOMRect): void {
    if (!this.box) return;
    const r = normaliseRect(from, to, { width: bounds.width, height: bounds.height }, 1);
    if (!r) {
      this.box.hidden = true;
      return;
    }
    this.box.hidden = false;
    this.box.style.left = `${r.x}px`;
    this.box.style.top = `${r.y}px`;
    this.box.style.width = `${r.width}px`;
    this.box.style.height = `${r.height}px`;
  }

  /** Tear the overlay down and report. `rect` is in client coordinates. */
  private finish(rect: ClientRect | null): void {
    this.start = null;
    this.dispose();
    this.onDone(rect);
  }

  dispose(): void {
    if (this.el) {
      this.el.remove();
      this.el = null;
    }
    this.box = null;
    this.start = null;
    window.removeEventListener("pointermove", this.onMove);
    window.removeEventListener("pointerup", this.onUp);
    window.removeEventListener("keydown", this.onKey, true);
  }
}
