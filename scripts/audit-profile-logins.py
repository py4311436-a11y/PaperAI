#!/usr/bin/env python3
"""What exactly is in the `logins` table of these Edge profiles?

A freshly created Chromium profile has ZERO rows there, yet every profile here
reports 267 — including the ones committed to git. Either the count is being
read from something other than saved credentials, or real saved passwords are
in the repository. This prints origins and whether a username/password is
present, never the values themselves.
"""

import os
import sqlite3
from collections import Counter

ROOT = r"D:\AIreader\PaperAI-PoC\evidence"

for dirpath, _d, _f in os.walk(ROOT):
    if not dirpath.replace("\\", "/").endswith("-profile"):
        continue
    p = os.path.join(dirpath, "Default", "Login Data")
    if not os.path.exists(p):
        continue
    name = os.path.basename(dirpath)
    print(f"\n=== {name} ===")
    con = sqlite3.connect(f"file:{p}?mode=ro&immutable=1", uri=True)
    try:
        tables = [
            r[0]
            for r in con.execute(
                "SELECT name FROM sqlite_master WHERE type IN ('table','view')"
            ).fetchall()
        ]
        print(f"  表/视图: {', '.join(tables)}")
        for t in ("logins", "stats", "accounts", "meta"):
            if t not in tables:
                continue
            n = con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
            print(f"  {t}: {n} 行")
        if "logins" in tables:
            cols = [r[1] for r in con.execute("PRAGMA table_info(logins)").fetchall()]
            print(f"  logins 列: {', '.join(cols)}")
            has_pw = "password_value" in cols
            sel = "origin_url"
            if "username_value" in cols:
                sel += ", username_value"
            if has_pw:
                sel += ", length(password_value)"
            rows = con.execute(f"SELECT {sel} FROM logins").fetchall()
            hosts = Counter()
            nonempty_user = 0
            nonempty_pw = 0
            for r in rows:
                u = r[0] or ""
                rest = u.split("://", 1)[-1]
                hosts[rest.split("/", 1)[0]] += 1
                if len(r) > 1 and r[1]:
                    nonempty_user += 1
                if len(r) > 2 and r[2]:
                    nonempty_pw += 1
            print(f"  非空用户名: {nonempty_user}/{len(rows)}   非空密码: {nonempty_pw}/{len(rows)}")
            print("  origin 站点（前 10）:")
            for h, c in hosts.most_common(10):
                print(f"    {c:>5}  {h}")
    finally:
        con.close()
