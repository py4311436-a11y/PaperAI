#!/usr/bin/env python3
"""Report what is actually inside any Edge profile directories.

These were produced by headless Edge launches with a fresh --user-data-dir, so
they *should* be empty. "Should be" is not good enough for something that is
committed to a repository, so read the databases and count rows.
"""

import os
import sqlite3
import sys

ROOT = r"D:\AIreader\PaperAI-PoC\evidence"

# (relative path, table to count, human label)
TARGETS = [
    ("Default/Network/Cookies", "cookies", "cookies"),
    ("Default/History", "urls", "history entries"),
    ("Default/Login Data", "logins", "saved logins"),
    ("Default/Web Data", "autofill", "autofill rows"),
    ("Default/Web Data", "token_service", "tokens"),
]

interesting = []

for dirpath, dirnames, filenames in os.walk(ROOT):
    if not dirpath.replace("\\", "/").endswith("-profile"):
        continue
    profile = dirpath
    name = os.path.basename(profile)
    print(f"\n=== {name} ===")
    total = 0
    for rel, table, label in TARGETS:
        p = os.path.join(profile, rel.replace("/", os.sep))
        if not os.path.exists(p):
            continue
        size = os.path.getsize(p)
        total += size
        count = "?"
        try:
            # Read-only: never mutate a profile we are inspecting.
            con = sqlite3.connect(f"file:{p}?mode=ro&immutable=1", uri=True)
            try:
                count = con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            except sqlite3.Error as e:
                count = f"(no table: {e})"
            finally:
                con.close()
        except sqlite3.Error as e:
            count = f"(unreadable: {e})"
        flag = "  <-- NON-EMPTY" if isinstance(count, int) and count > 0 else ""
        print(f"  {label:<18} {size:>9} bytes  rows={count}{flag}")
        if isinstance(count, int) and count > 0:
            interesting.append((name, label, count))
    if total == 0:
        print("  (no credential-ish databases present at all)")

print("\n=== 结论 ===")
if interesting:
    print("发现非空数据：")
    for n, l, c in interesting:
        print(f"  {n}: {l} = {c}")
    sys.exit(1)
print("所有 profile 的 Cookies / History / Login Data / Web Data 均为 0 行。")
