#!/usr/bin/env python3
"""Objective check: does a screenshot contain PDF-highlight yellow pixels?

Rather than eyeballing captures, scan for the characteristic highlight colour
(high R, high G, low-ish B) over a large connected area. This is what the
cross-reader verification hinges on.
"""
import sys
from collections import deque

try:
    from PIL import Image
except ImportError:
    print("Pillow not available; pip install pillow")
    sys.exit(3)


def highlight_pixels(path):
    im = Image.open(path).convert("RGB")
    w, h = im.size
    px = im.load()
    mask = [[False] * w for _ in range(h)]
    count = 0
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y]
            # PDF.js default highlight: C [1 0.941 0.4] -> (255, 240, 102)
            if r > 200 and g > 170 and b < 190 and (r - b) > 60:
                mask[y][x] = True
                count += 1
    return count, mask, w, h


def largest_region(mask, w, h):
    """Size of the largest 4-connected blob of highlight pixels."""
    seen = [[False] * w for _ in range(h)]
    best = 0
    best_box = None
    for y in range(h):
        for x in range(w):
            if not mask[y][x] or seen[y][x]:
                continue
            q = deque([(x, y)])
            seen[y][x] = True
            size = 0
            minx = maxx = x
            miny = maxy = y
            while q:
                cx, cy = q.popleft()
                size += 1
                minx, maxx = min(minx, cx), max(maxx, cx)
                miny, maxy = min(miny, cy), max(maxy, cy)
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = cx + dx, cy + dy
                    if 0 <= nx < w and 0 <= ny < h and mask[ny][nx] and not seen[ny][nx]:
                        seen[ny][nx] = True
                        q.append((nx, ny))
            if size > best:
                best = size
                best_box = (minx, miny, maxx, maxy)
    return best, best_box


def ink_pixels(path):
    """Dark, low-saturation strokes are hard to separate from text; report the
    count of near-black pixels outside the text rows instead."""
    im = Image.open(path).convert("RGB")
    w, h = im.size
    px = im.load()
    n = 0
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y]
            if r < 70 and g < 70 and b < 70:
                n += 1
    return n


for p in sys.argv[1:]:
    hl, mask, w, h = highlight_pixels(p)
    big, box = largest_region(mask, w, h)
    dark = ink_pixels(p)
    verdict = "HIGHLIGHT VISIBLE" if big >= 400 else "no highlight blob found"
    print(f"{p}")
    print(f"  size={w}x{h}  highlight-pixels={hl}  largest-blob={big}px  box={box}")
    print(f"  dark(ink/text)-pixels={dark}")
    print(f"  => {verdict}")
    print()
