#!/usr/bin/env python3
"""Count every contiguous highlight blob in a screenshot.

Needed because the largest-blob-only check can hide the fact that a single
Highlight annotation may render as several line segments, or that a reader
added something of its own. We want to know exactly how many distinct
highlighted regions are on screen.
"""
import sys
from collections import deque

try:
    from PIL import Image
except ImportError:
    print("Pillow not available")
    sys.exit(3)


def blobs(path, min_size=200):
    im = Image.open(path).convert("RGB")
    w, h = im.size
    px = im.load()

    mask = [[False] * w for _ in range(h)]
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y]
            # PDF.js default highlight colour is C [1 0.941 0.4] -> (255,240,102)
            if r > 200 and g > 170 and b < 190 and (r - b) > 60:
                mask[y][x] = True

    seen = [[False] * w for _ in range(h)]
    found = []
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
            if size >= min_size:
                found.append((size, (minx, miny, maxx, maxy)))

    found.sort(reverse=True)
    return w, h, found


for p in sys.argv[1:]:
    w, h, found = blobs(p)
    print(f"{p}  ({w}x{h})")
    print(f"  contiguous highlight blobs >= 200px: {len(found)}")
    for size, box in found[:12]:
        bw = box[2] - box[0]
        bh = box[3] - box[1]
        print(f"    {size:7d} px  {bw:4d}x{bh:<4d} at ({box[0]},{box[1]})-({box[2]},{box[3]})")
    print()
