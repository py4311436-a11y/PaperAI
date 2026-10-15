#!/usr/bin/env python3
"""Extract the text that falls inside a PDF annotation's QuadPoints.

Purpose: prove the highlight we wrote is on the text we intended, not merely
that *a* yellow box exists. Parses the page content stream directly — no PDF.js,
no reader — so it is an independent check of our own output.

Usage:
    python tools/text_at_annot.py <file.pdf> <page_index_0based> \
        <x0> <y0> <x1> <y1>          # PDF user-space coords, y from bottom
"""
import re
import sys
import zlib


def iter_stream_objects(data):
    """Yield decoded stream bodies for every `stream ... endstream` block."""
    for m in re.finditer(rb"stream\r?\n", data):
        start = m.end()
        end = data.find(b"endstream", start)
        if end < 0:
            continue
        raw = data[start:end]
        try:
            yield zlib.decompress(raw)
        except Exception:
            # Not flate — could be plain or another filter; skip quietly.
            continue


def parse_text(stream):
    """Return [(text, x, y)] for text-showing ops, tracking Td/Tm/TD."""
    out = []
    # Tokenise into strings, numbers and operators, roughly.
    tokens = re.findall(
        rb"\((?:\\.|[^\\()])*\)|\[[^\]]*\]|<[0-9A-Fa-f\s]*>|[-+]?\d*\.?\d+|/[^\s/\[\]<>()]*|[A-Za-z'\"*]+",
        stream,
    )
    stack = []
    tm = [1, 0, 0, 1, 0, 0]      # text matrix
    tlm = [1, 0, 0, 1, 0, 0]     # line matrix
    leading = 0.0

    def num(t):
        try:
            return float(t)
        except Exception:
            return None

    def unescape(b):
        s = b[1:-1]
        s = re.sub(rb"\\([nrtbf()\\])", lambda m: {b"n": b"\n", b"r": b"\r", b"t": b"\t", b"b": b"\b", b"f": b"\f"}.get(m.group(1), m.group(1)), s)
        s = re.sub(rb"\\[0-7]{1,3}", lambda m: bytes([int(m.group(0)[1:], 8) & 0xFF]), s)
        return s.decode("latin-1")

    for t in tokens:
        if t.startswith(b"("):
            stack.append(("str", unescape(t)))
        elif re.fullmatch(rb"[-+]?\d*\.?\d+", t):
            stack.append(("num", num(t)))
        elif t == b"[":
            stack.append(("arr", []))
        elif t == b"]":
            # collapse array
            items = []
            while stack and stack[-1][0] != "arr":
                items.insert(0, stack.pop())
            if stack and stack[-1][0] == "arr":
                stack.pop()
                stack.append(("arr", items))
        else:
            op = t.decode("latin-1")
            if op == "Td" or op == "TD":
                tx = ty = 0.0
                nums = [v for k, v in stack if k == "num"]
                if len(nums) >= 2:
                    tx, ty = nums[-2], nums[-1]
                if op == "TD":
                    leading = -ty
                tlm = [
                    tlm[0], tlm[1], tlm[2], tlm[3],
                    tlm[4] + tx * tlm[0] + ty * tlm[2],
                    tlm[5] + tx * tlm[1] + ty * tlm[3],
                ]
                tm = list(tlm)
            elif op == "Tm":
                nums = [v for k, v in stack if k == "num"]
                if len(nums) >= 6:
                    tm = nums[-6:]
                    tlm = list(tm)
            elif op == "T*":
                tlm = [tlm[0], tlm[1], tlm[2], tlm[3], tlm[4] + leading * tlm[2], tlm[5] + leading * tlm[3]]
                tm = list(tlm)
            elif op == "BT":
                tm = [1, 0, 0, 1, 0, 0]
                tlm = list(tm)
            elif op in ("Tj", "'", '"'):
                s = ""
                for k, v in reversed(stack):
                    if k == "str":
                        s = v
                        break
                    if k == "arr":
                        s = "".join(x for kk, x in v if kk == "str")
                        break
                if s:
                    out.append((s, tm[4], tm[5]))
                if op == "'":
                    tlm = [tlm[0], tlm[1], tlm[2], tlm[3], tlm[4] + leading * tlm[2], tlm[5] + leading * tlm[3]]
                    tm = list(tlm)
            elif op == "TJ":
                s = ""
                for k, v in reversed(stack):
                    if k == "arr":
                        s = "".join(x for kk, x in v if kk == "str")
                        break
                if s:
                    out.append((s, tm[4], tm[5]))
            stack = []

    return out


def main():
    if len(sys.argv) < 7:
        print(__doc__)
        sys.exit(2)
    path, page_i = sys.argv[1], int(sys.argv[2])
    x0, y0, x1, y1 = map(float, sys.argv[3:7])

    data = open(path, "rb").read()

    # Find the Nth /Type /Page (not /Pages) object's content streams.
    pages = []
    for m in re.finditer(rb"(\d+)\s+0\s+obj(.*?)endobj", data, re.S):
        body = m.group(2)
        if re.search(rb"/Type\s*/Page\b(?!s)", body) and b"/Contents" in body:
            pages.append(body)
    if page_i >= len(pages):
        print(f"only {len(pages)} page objects found")
        sys.exit(1)
    page = pages[page_i]

    # Contents may be a ref or an array of refs.
    refs = re.findall(rb"/Contents\s*(?:\[([^\]]*)\]|(\d+)\s+0\s+R)", page)
    want = []
    for arr, single in refs:
        if single:
            want.append(single.decode())
        elif arr:
            want += [r.split()[0].decode() for r in arr.split(b"R") if r.strip()]

    texts = []
    for w in want:
        m = re.search(rb"(?<!\d)" + re.escape(w.encode()) + rb"\s+0\s+obj(.*?)endobj", data, re.S)
        if not m:
            continue
        for stream in iter_stream_objects(data[m.start():]):
            texts.extend(parse_text(stream))

    hits = [(t, x, y) for (t, x, y) in texts if x0 - 2 <= x <= x1 + 2 and y0 - 2 <= y <= y1 + 2]

    print(f"page {page_i}: {len(texts)} text runs, {len(hits)} inside the quad")
    print(f"quad = ({x0}, {y0}) .. ({x1}, {y1})")
    for t, x, y in hits:
        print(f"   ({x:7.2f},{y:7.2f})  {t!r}")
    if not hits:
        print("   (nothing directly inside; showing runs within +-30pt vertically)")
        for t, x, y in sorted(
            [(t, x, y) for (t, x, y) in texts if y0 - 30 <= y <= y1 + 30],
            key=lambda r: (r[2], r[1]),
        )[:25]:
            print(f"   ({x:7.2f},{y:7.2f})  {t!r}")


if __name__ == "__main__":
    main()
