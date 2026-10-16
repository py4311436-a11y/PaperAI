/**
 * Screenshot capture and downscaling.
 *
 * Why this module exists at all: DeepSeek caps an image at a flat 384 tokens,
 * which means it downscales aggressively on its own side. Shipping a 4K
 * screenshot therefore pays the full upload cost and latency for detail the
 * model will never see. Everything here is about spending as few bytes as
 * possible while keeping what the user actually pointed at.
 *
 * The pure parts (`fitWithin`, `attemptPlan`) are separated from the canvas work
 * so the sizing rules are testable without a DOM.
 */

/** A finished, sendable screenshot. */
export interface CaptureResult {
  /** `data:image/png;base64,...` — final, never re-encoded downstream. */
  url: string;
  /**
   * Length of the whole `data:` URL, prefix included.
   *
   * The full length rather than the base64 alone, because that is what goes on
   * the wire and what Rust measures against its own ceiling — two different
   * numbers for the same thing is how a limit ends up enforced twice, differently.
   */
  chars: number;
  width: number;
  height: number;
  /** Which encoding finally fit. Surfaced so the UI can say "已压缩为 JPEG". */
  mime: string;
}

export interface CaptureLimits {
  /** Longest side after downscaling. */
  maxEdge: number;
  /** Ceiling on the base64 payload. */
  maxChars: number;
}

/**
 * Defaults, and the reasoning behind each.
 *
 * `maxEdge: 1568` — the point where a chart's axis labels and a formula's
 * subscripts are still legible after the provider's own downscale. Larger buys
 * nothing against a 384-token cap.
 *
 * `maxChars: 4 MiB` — comfortably inside DeepSeek's 48 MiB body ceiling and
 * OpenAI's 20 MB per-image limit, and small enough that a handful of screenshots
 * cannot blow up a request. Rust enforces its own ceiling too; this one exists
 * so the user gets a message they can act on.
 */
export const DEFAULT_CAPTURE_LIMITS: CaptureLimits = {
  maxEdge: 1568,
  maxChars: 4 * 1024 * 1024,
};

/**
 * The size a region must be drawn at to fit `maxEdge`.
 *
 * Shrink-only: a small region is never upscaled, because inventing pixels does
 * not add information and costs bytes.
 */
export function fitWithin(
  w: number,
  h: number,
  maxEdge: number
): { width: number; height: number } {
  const width = Math.max(0, Math.floor(w));
  const height = Math.max(0, Math.floor(h));
  if (width === 0 || height === 0) return { width: 0, height: 0 };
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const k = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * k)),
    height: Math.max(1, Math.round(height * k)),
  };
}

/** One rung of the encode ladder. */
export interface AttemptPlan {
  mime: "image/png" | "image/jpeg";
  quality?: number;
  /** Multiplier on top of `fitWithin`, for when quality alone is not enough. */
  scale: number;
}

/**
 * The encode ladder.
 *
 * PNG first, always: a figure or a formula is line art, and JPEG's 8×8 blocks
 * put ringing artefacts exactly where the detail is. Only when PNG will not fit
 * — which means the region is photographic, not diagrammatic — does it fall
 * back to JPEG, and only then does the scale start coming down.
 *
 * Four rungs is deliberate: past the last one the region is simply too big to
 * send, and saying so beats sending something illegible.
 */
export function attemptPlan(attempt: number): AttemptPlan {
  switch (attempt) {
    case 0:
      return { mime: "image/png", scale: 1 };
    case 1:
      return { mime: "image/jpeg", quality: 0.85, scale: 1 };
    case 2:
      return { mime: "image/jpeg", quality: 0.85, scale: 0.7 };
    default:
      return { mime: "image/jpeg", quality: 0.8, scale: 0.5 };
  }
}

export const MAX_ATTEMPTS = 4;

/** Rect of the source canvas to capture, in source pixels. */
export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Creates a blank canvas of the given size.
 *
 * A seam, not an abstraction: the encode ladder is the part with real rules in
 * it, and those rules are only testable if the canvas can be stood in for. In
 * the app this is `document.createElement`.
 */
export type CanvasFactory = (width: number, height: number) => HTMLCanvasElement;

const browserCanvas: CanvasFactory = (width, height) => {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  return c;
};

/**
 * Capture a region of an already-rendered canvas, downscaled to fit.
 *
 * The source is the canvas pdf.js has already painted, so nothing here touches
 * the PDF again — the region is re-drawn, not re-rendered. That matters for
 * scanned pages: they have no text layer, but they do have pixels, so this is
 * the only path that can get a figure out of them.
 *
 * @param encode Injectable for tests. Defaults to a real canvas round-trip.
 * @param makeCanvas Injectable for tests.
 */
export async function captureRegion(
  source: HTMLCanvasElement,
  region: Region,
  limits: CaptureLimits = DEFAULT_CAPTURE_LIMITS,
  encode?: (canvas: HTMLCanvasElement, plan: AttemptPlan) => string,
  makeCanvas: CanvasFactory = browserCanvas
): Promise<CaptureResult> {
  const w = Math.max(0, Math.floor(region.width));
  const h = Math.max(0, Math.floor(region.height));
  if (w === 0 || h === 0) {
    throw new Error("截图区域为空：请框选一块内容");
  }

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const plan = attemptPlan(attempt);
    const base = fitWithin(w, h, limits.maxEdge);
    const target = {
      width: Math.max(1, Math.round(base.width * plan.scale)),
      height: Math.max(1, Math.round(base.height * plan.scale)),
    };

    const canvas = makeCanvas(target.width, target.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法创建画布上下文");
    // A white matte, so a transparent region of the page does not turn into a
    // black hole once it is encoded without an alpha channel.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, target.width, target.height);
    ctx.drawImage(
      source,
      Math.floor(region.x),
      Math.floor(region.y),
      w,
      h,
      0,
      0,
      target.width,
      target.height
    );

    const url = encode
      ? encode(canvas, plan)
      : canvas.toDataURL(plan.mime, plan.quality);
    const chars = url.length;

    if (chars <= limits.maxChars) {
      return { url, chars, width: target.width, height: target.height, mime: plan.mime };
    }
  }

  throw new Error(
    `截图过大（超过 ${Math.round(limits.maxChars / 1024 / 1024)} MiB），请框选更小的区域`
  );
}

/** Human-readable size, for the attachment chip. */
export function describeChars(chars: number): string {
  if (chars < 1024) return `${chars} B`;
  if (chars < 1024 * 1024) return `${(chars / 1024).toFixed(0)} KB`;
  return `${(chars / 1024 / 1024).toFixed(1)} MB`;
}
