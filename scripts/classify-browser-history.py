#!/usr/bin/env python3
"""Decide whether a committed Edge profile holds the user's real browsing data.

Rather than dumping URLs into a log, classify history entries:
  - experiment traffic (localhost / 127.0.0.1 / edge:// / file:// / our paths)
  - anything else, which would be real browsing

Only hostnames of the "anything else" bucket are summarised, and only in
aggregate counts, so the answer is clear without reproducing anyone's history.
"""

import os
import sqlite3
import sys
from collections import Counter

ROOT = r"D:\AIreader\PaperAI-PoC\evidence"

BENIGN_SCHEMES = ("edge://", "chrome://", "devtools://", "file://", "data:", "about:", "blob:")
BENIGN_HOSTS = ("localhost", "127.0.0.1", "0.0.0.0")

def classify(url: str) -> str:
    u = (url or "").lower()
    if u.startswith(BENIGN_SCHEMES):
        return "benign-scheme"
    rest = u.split("://", 1)[-1]
    host = rest.split("/", 1)[0].split(":", 1)[0]
    if any(host == h or host.endswith("." + h) for h in BENIGN_HOSTS):
        return "benign-host"
    return "external"

overall_external = Counter()
found_any = False

for dirpath, _dirnames, _filenames in os.walk(ROOT):
    if not dirpath.replace("\\", "/").endswith("-profile"):
        continue
    hist = os.path.join(dirpath, "Default", "History")
    if not os.path.exists(hist):
        continue
    found_any = True
    name = os.path.basename(dirpath)
    con = sqlite3.connect(f"file:{hist}?mode=ro&immutable=1", uri=True)
    try:
        rows = con.execute(
            "SELECT url, COALESCE(title,''), visit_count FROM urls"
        ).fetchall()
    finally:
        con.close()

    buckets = Counter(classify(r[0]) for r in rows)
    ext = [r for r in rows if classify(r[0]) == "external"]
    print(f"\n=== {name} ({len(rows)} entries) ===")
    for k in ("benign-scheme", "benign-host", "external"):
        print(f"  {k:<15} {buckets.get(k, 0)}")
    if ext:
        print("  external 条目（仅统计，不打印完整 URL）:")
        hosts = Counter()
        for u, _t, _v in ext:
            rest = u.lower().split("://", 1)[-1]
            hosts[rest.split("/", 1)[0]] += 1
        for h, c in hosts.most_common(12):
            print(f"    {c:>5}  {h}")
        overall_external.update(hosts)

print("\n=== 结论 ===")
if not found_any:
    print("没有可读的 History 数据库。")
    sys.exit(0)
total_ext = sum(overall_external.values())
if total_ext == 0:
    print("所有 profile 的历史记录都是实验流量（localhost / edge:// / file://），")
    print("不含任何真实网站访问。")
    sys.exit(0)
print(f"外部（非实验）历史条目共 {total_ext} 条，涉及 {len(overall_external)} 个站点。")
print("需要清理，并确认这些来源。")
sys.exit(1)
