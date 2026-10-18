/**
 * Tests for the Ctrl+wheel zoom gesture.
 *
 * The bug these lock down: zooming towards the centre of the document instead
 * of towards the cursor. The arithmetic for that lives in PDF.js (`origin`),
 * so what is testable here is everything around it — the direction, the step
 * size, the bounds, and the decision of whether an event is the gesture at all.
 *
 * Those are the parts that fail silently. A sign error makes zoom-in zoom out;
 * a missing bound lets the page shrink to a dot or blow past the viewer's own
 * limit; and a gesture test that only checks "it zoomed" passes while the page
 * zooms the wrong way at the wrong speed.
 *
 * Run via `node scripts/run-ai-unit-tests.mjs`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
    MAX_ZOOM,
    MIN_ZOOM,
    ZOOM_DELTA,
    clampZoom,
    isZoomGesture,
    zoomFactorFor,
} from "../../dist-test/src/pdf/wheel-zoom.js";

// ------------------------------------------------------------------- direction

test("rolling up zooms in and rolling down zooms out", () => {
    // The sign is the whole gesture. deltaY is negative when the wheel rolls
    // towards the user, which is the direction every reader maps to zoom-in.
    assert.ok(zoomFactorFor(-100) > 1, "wheel up must zoom in");
    assert.ok(zoomFactorFor(100) < 1, "wheel down must zoom out");
});

test("the step size is one notch regardless of how far the wheel travelled", () => {
    // A trackpad emits a continuum of small deltas; a mouse wheel emits large
    // ones. Making the step proportional would make zoom speed depend on the
    // hardware rather than on the gesture.
    assert.equal(zoomFactorFor(-10), ZOOM_DELTA);
    assert.equal(zoomFactorFor(-400), ZOOM_DELTA);
    assert.equal(zoomFactorFor(10), 1 / ZOOM_DELTA);
    assert.equal(zoomFactorFor(400), 1 / ZOOM_DELTA);
});

test("deltaMode does not change the direction or the step", () => {
    // 0 = pixels, 1 = lines, 2 = pages. The sign means the same thing in all
    // three, and only the sign is used — scaling by the mode would make the
    // same gesture behave differently under a browser setting the user never
    // sees.
    for (const mode of [0, 1, 2]) {
        assert.equal(zoomFactorFor(-120, mode), ZOOM_DELTA, `mode ${mode} zoom-in`);
        assert.equal(zoomFactorFor(120, mode), 1 / ZOOM_DELTA, `mode ${mode} zoom-out`);
    }
});

test("a zero or unusable delta does not zoom", () => {
    // Some devices report 0 for a notch, and a 0 factor would be a no-op that
    // still fires a re-render. NaN and Infinity are not measurements at all, so
    // they must not be read as a direction either -- see the note on
    // `zoomFactorFor` for why "no zoom" beats guessing.
    assert.equal(zoomFactorFor(0), 1);
    assert.equal(zoomFactorFor(Number.NaN), 1);
    assert.equal(zoomFactorFor(Number.POSITIVE_INFINITY), 1);
    assert.equal(zoomFactorFor(Number.NEGATIVE_INFINITY), 1);
});

// ---------------------------------------------------------------------- bounds

test("clampZoom keeps the scale inside the usable range", () => {
    assert.equal(clampZoom(0.001), MIN_ZOOM, "must not shrink to a dot");
    assert.equal(clampZoom(100), MAX_ZOOM, "must not grow past the viewer's limit");
    assert.equal(clampZoom(1), 1, "a normal scale is untouched");
});

test("clampZoom survives a non-finite scale", () => {
    // A NaN scale would break the viewer's rendering outright, so the clamp is
    // the last line of defence and has to return something usable.
    //
    // It returns 1, not MAX_ZOOM, for Infinity: a non-finite input means the
    // scale was already computed wrongly upstream, and clamping that to the
    // ceiling would apply the consequence of the bad value -- the page jumping
    // to maximum zoom. Neutral is the safe landing.
    assert.equal(clampZoom(Number.NaN), 1);
    assert.equal(clampZoom(Number.POSITIVE_INFINITY), 1);
    assert.equal(clampZoom(Number.NEGATIVE_INFINITY), 1);
});

test("the bounds are wide enough to be useful and narrow enough to be safe", () => {
    // Too narrow and a dense figure cannot be read; too wide and one notch of
    // the wheel empties the viewport.
    assert.ok(MIN_ZOOM < 0.5, "must be able to see a whole page at once");
    assert.ok(MAX_ZOOM > 3, "must be able to read a dense figure");
});

test("repeated zoom-in converges on the ceiling instead of overshooting", () => {
    // This is what the wheel actually does: many notches in a row. Each step
    // must be clamped, or the last one lands past the limit and the viewer
    // refuses it.
    let scale = 1;
    for (let i = 0; i < 100; i++) scale = clampZoom(scale * ZOOM_DELTA);
    assert.equal(scale, MAX_ZOOM);
});

test("repeated zoom-out converges on the floor", () => {
    let scale = 1;
    for (let i = 0; i < 100; i++) scale = clampZoom(scale / ZOOM_DELTA);
    assert.equal(scale, MIN_ZOOM);
});

// --------------------------------------------------------------------- gesture

test("Ctrl is the zoom modifier", () => {
    assert.equal(isZoomGesture({ ctrlKey: true }), true);
});

test("a plain wheel is not the zoom gesture", () => {
    // This is the one that matters most for not breaking scrolling: without it
    // every wheel notch would zoom instead of scroll.
    assert.equal(isZoomGesture({}), false);
    assert.equal(isZoomGesture({ shiftKey: true }), false);
    assert.equal(isZoomGesture({ altKey: true }), false);
});

test("Shift+Ctrl still counts, rather than working on one machine only", () => {
    // Some platforms report Ctrl+Shift for certain input methods. Refusing
    // those would make the gesture fail for reasons the user cannot see.
    assert.equal(isZoomGesture({ ctrlKey: true, shiftKey: true }), true);
});

test("metaKey is treated as Ctrl for the same reason", () => {
    // macOS reports Cmd rather than Ctrl. The app is Windows-only today, but
    // the gesture is not worth re-deriving if that changes.
    assert.equal(isZoomGesture({ metaKey: true }), true);
});
