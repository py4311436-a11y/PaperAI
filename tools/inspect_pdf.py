"""
PaperAI PoC — Test 4 ground truth check.

Purpose: prove/disprove that PDF.js saveDocument() output contains REAL PDF
annotation objects, rather than canvas/HTML overlay.

Method: parse the produced PDF at the byte level:
  1. find /Annots arrays in page objects
  2. find /Subtype /Highlight and /Subtype /Ink dictionaries
  3. confirm /QuadPoints (highlight geometry) and /InkList (ink geometry)
This is independent of PDF.js itself -> real cross-reader evidence.
"""
import re, sys, zlib, json, os

def load(path):
    with open(path, "rb") as f:
        return f.read()

def scan(data: bytes):
    out = {
        "file": None,
        "size": len(data),
        "header": data[:9].decode("latin-1", "replace"),
        "has_AcroForm": b"/AcroForm" in data,
        "subtype_Highlight": len(re.findall(rb"/Subtype\s*/Highlight", data)),
        "subtype_Ink": len(re.findall(rb"/Subtype\s*/Ink", data)),
        "subtype_Link": len(re.findall(rb"/Subtype\s*/Link", data)),
        "subtype_Text": len(re.findall(rb"/Subtype\s*/Text", data)),
        "Annots_arrays": len(re.findall(rb"/Annots", data)),
        "QuadPoints": len(re.findall(rb"/QuadPoints", data)),
        "InkList": len(re.findall(rb"/InkList", data)),
        "C_strings_in_rect": len(re.findall(rb"/Rect", data)),
        "AP_streams": len(re.findall(rb"/AP", data)),
        "XFA": b"/XFA" in data,
    }
    return out

def dump_annots(data: bytes, limit=5):
    """Extract contexts around Highlight/Ink subtypes."""
    res = []
    for pat in [rb"/Subtype\s*/Highlight", rb"/Subtype\s*/Ink"]:
        for m in re.finditer(pat, data):
            s = max(0, m.start() - 400)
            e = min(len(data), m.end() + 500)
            ctx = data[s:e]
            txt = re.sub(rb"[^\x20-\x7e]", b".", ctx).decode("ascii", "replace")
            res.append({"pattern": pat.decode(), "context": txt})
            if len(res) >= limit:
                return res
    return res

if __name__ == "__main__":
    path = sys.argv[1]
    data = load(path)
    rep = scan(data)
    rep["file"] = path
    rep["size_mb"] = round(len(data) / 1024 / 1024, 3)
    print(json.dumps(rep, indent=2, ensure_ascii=False))
    print("\n--- annotation object contexts ---")
    for c in dump_annots(data):
        print(f"\n[{c['pattern']}]\n{c['context']}\n")