/**
 * Ctrl+wheel zoom for the PDF page.
 *
 * The gesture: hold Ctrl and roll the wheel. The page zooms, and it zooms
 * *towards the cursor* rather than towards the middle of the document — which
 * is what every PDF reader does and what makes the gesture usable at all.
 * Zooming to the centre means the thing you pointed at slides out from under
 * the pointer, so you zoom, lose your place, scroll back, zoom again.
 *
 * Two things are kept apart on purpose:
 *
 *  - **The arithmetic** (`zoomFactorFor`, `clampZoom`, `isZoomGesture`) is pure
 *    and lives here, so it can be tested in Node with no browser. The bounds
 *    and the direction are exactly the kind of thing that looks right and is
 *    off by a sign or an order of magnitude, and neither is visible in a
 *    screenshot.
 *  - **The DOM wiring** lives in the adapter, which owns the viewer and the
 *    scroll container. It cannot be unit-tested, so it is kept as thin as
 *    possible and every decision it makes is one of the pure functions'.
 *    Cursor anchoring in particular is handed to the viewer's own `origin`
 *    option rather than reimplemented — see the comment there.
 *
 * On the modifier: the request was for the *left* Ctrl specifically. A
 * `WheelEvent` carries only `ctrlKey` — no `code`, no `location`, nothing that
 * says which physical key is down — so the left/right distinction is not
 * available at the moment the gesture happens. Tracking it through keydown /
 * keyup would mean guessing at state that can be missed (a keyup outside the
 * window leaves the flag stuck), and getting it wrong fails silently: the
 * gesture just stops working, with nothing on screen to say why.
 *
 * So any Ctrl zooms. That is also what every other PDF reader does, and it is
 * the behaviour a user pressing the left key — the one they were asked for —
 * actually gets.
 */

/** One wheel notch, as a multiplier. Matches PDF.js's own DEFAULT_SCALE_DELTA. */
export const ZOOM_DELTA = 1.1;

/** Zoom bounds. PDF.js clamps to 0.1–25; these are the usable ends for a reader. */
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 5;

/**
 * The scale factor for one wheel notch.
 *
 * Rolling up (negative `deltaY`) zooms in. The magnitude is deliberately
 * constant rather than proportional to `deltaY`: trackpads and high-resolution
 * mice emit a continuum of small values, and a proportional response makes the
 * zoom speed depend on the hardware instead of on the gesture. One notch, one
 * step, whatever produced it.
 *
 * A non-finite delta returns 1 — no zoom — rather than being treated as a
 * direction. `Infinity` is not `-Infinity`, so it would read as "zoom out" and
 * shrink the page on a value the device never actually sent; `NaN` compares
 * false against everything and would be decided by whatever the comparison
 * happens to evaluate to. Either way the caller would apply a scale change
 * built from a number that is not a measurement, so the gesture is ignored.
 *
 * `deltaMode` is accepted and deliberately unused for magnitude: only the
 * direction is taken from it. A `WheelEvent` in line or page mode is not in
 * pixels (0 = pixels, 1 = lines, 2 = pages), but the sign means the same thing
 * in all three, and the direction is all this needs. Scaling the step by the
 * mode would make the same gesture zoom at different speeds depending on a
 * browser setting the user never sees.
 */
export function zoomFactorFor(deltaY: number, deltaMode = 0): number {
    if (!Number.isFinite(deltaY) || deltaY === 0) return 1;
    void deltaMode; // see above: direction only
    return deltaY < 0 ? ZOOM_DELTA : 1 / ZOOM_DELTA;
}

/** Clamp a scale into the usable range. */
export function clampZoom(scale: number): number {
    if (!Number.isFinite(scale)) return 1;
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
}

/**
 * Whether a wheel event is the zoom gesture.
 *
 * Ctrl held, and the event is a zoomable one. Shift is not excluded: some
 * platforms report Ctrl+Shift for certain input methods, and refusing those
 * would make the gesture work on one machine and not another for no reason the
 * user could act on.
 */
export function isZoomGesture(e: {
    ctrlKey?: boolean;
    metaKey?: boolean;
}): boolean {
    return Boolean(e.ctrlKey || e.metaKey);
}
