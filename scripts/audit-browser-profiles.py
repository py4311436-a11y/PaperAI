#!/usr/bin/env python3
"""Audit browser-profile data: is any of it in the repo, and how bad is it?

Written after 1477 Edge-profile files — including a `Login Data` with 267 saved
credential rows and the `Local State` that carries the key protecting them —
were committed by the Phase-2 CDP experiments. `scripts/verify-no-profile-data.mjs`
is the fast guard; this is the forensic tool for when you need to know exactly
what leaked.

Usage:
    python scripts/audit-browser-profiles.py

Reports, per profile directory:
  * row counts for Cookies / History / Login Data / Web Data
  * whether the stored password blobs are ciphertext or plaintext
  * whether the directories are tracked by git
  * whether they are symlinks or junctions (must be checked BEFORE deleting —
    deleting a junction would destroy whatever it points at)

Never prints a password, a username, or a full URL.
"""

import os
import sqlite3
import subprocess
import sys
from collections import Counter

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

BENIGN_SCHEMES = ("edge://", "chrome://", "devtools://", "file://", "data:", "about:", "blob:")
BENIGN_HOSTS = ("localhost", "127.0.0.1", "0.0.0.0")

TABLES = [
    ("Default/Network/Cookies", "cookies", "cookies"),
    ("Default/History", "urls", "history entries"),
    ("Default/Login Data", "logins", "saved logins"),
    ("Default/Web Data", "autofill", "autofill rows"),
]


def tracked_files():
    try:
        out = subprocess.run(
            ["git", "ls-files"], cwd=REPO, capture_output=True, text=True, check=True
        ).stdout
        return set(out.splitlines())
    except Exception:
        return set()


def ro(path):
    return sqlite3.connect(f"file:{path}?mode=ro&immutable=1", uri=True)


def find_profiles():
    found = []
    for dirpath, dirnames, _f in os.walk(REPO):
        if dirpath.replace("\\", "/").endswith("-profile"):
            found.append(dirpath)
            dirnames[:] = []
    return sorted(found)


def classify(url: str) -> str:
    u = (url or "").lower()
    if u.startswith(BENIGN_SCHEMES):
        return "benign"
    host = u.split("://", 1)[-1].split("/", 1)[0].split(":", 1)[0]
    if any(host == h or host.endswith("." + h) for h in BENIGN_HOSTS):
        return "benign"
    return "external"


def main():
    tracked = tracked_files()
    profiles = find_profiles()

    if not profiles:
        print("仓库内没有任何 *-profile 目录。")
        print(f"被跟踪文件数: {len(tracked)}")
        print("运行 `node scripts/verify-no-profile-data.mjs` 做正式判定。")
        return 0

    print(f"发现 {len(profiles)} 个 profile 目录\n")
    verdict_nonempty = False
    verdict_tracked = False
    verdict_external = Counter()

    for p in profiles:
        rel = os.path.relpath(p, REPO).replace("\\", "/")
        in_git = any(t.startswith(rel + "/") for t in tracked)
        print(f"=== {rel} ===")
        print(f"  被 git 跟踪: {'是 —— 严重！' if in_git else '否'}")
        if in_git:
            verdict_tracked = True

        # A junction/symlink here would mean deleting the "copy" destroys the
        # real profile. Always check before cleanup.
        real = os.path.realpath(p).replace("\\", "/")
        print(f"  真实路径: {real}")
        if not real.endswith(rel.split("/")[-1]):
            print("  !! 是符号链接/junction —— 删除前必须确认它指向哪里")

        for sub, table, label in TABLES:
            q = os.path.join(p, sub.replace("/", os.sep))
            if not os.path.exists(q):
                continue
            try:
                con = ro(q)
                try:
                    n = con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                finally:
                    con.close()
            except sqlite3.Error as e:
                print(f"  {label:<16} (读取失败: {e})")
                continue
            print(f"  {label:<16} {n:>6} 行  ({os.path.getsize(q)} bytes)")
            if n:
                verdict_nonempty = True

        # Plaintext or ciphertext?
        login = os.path.join(p, "Default", "Login Data")
        if os.path.exists(login):
            try:
                con = ro(login)
                try:
                    rows = con.execute("SELECT password_value FROM logins").fetchall()
                finally:
                    con.close()
                tags = Counter()
                for (blob,) in rows:
                    if not blob:
                        tags["(empty)"] += 1
                    else:
                        raw = bytes(blob)
                        tags[raw[:3].decode("ascii", "replace") if raw[:1] == b"v" else "(binary)"] += 1
                pretty = ", ".join(f"{k}={v}" for k, v in sorted(tags.items()))
                print(f"  密码字段: {pretty}   [v10/v20 = DPAPI/AES 密文，非明文]")
            except sqlite3.Error:
                pass

        # Where did the history go?
        hist = os.path.join(p, "Default", "History")
        if os.path.exists(hist):
            try:
                con = ro(hist)
                try:
                    rows = con.execute("SELECT url FROM urls").fetchall()
                finally:
                    con.close()
                buckets = Counter(classify(r[0]) for r in rows)
                print(
                    f"  历史: 实验流量={buckets.get('benign', 0)}  "
                    f"外部网站={buckets.get('external', 0)}"
                )
                if buckets.get("external"):
                    verdict_nonempty = True
                    hosts = Counter()
                    for (u,) in rows:
                        if classify(u) == "external":
                            hosts[u.lower().split("://", 1)[-1].split("/", 1)[0]] += 1
                    verdict_external.update(hosts)
            except sqlite3.Error:
                pass
        print()

    print("=== 结论 ===")
    if verdict_tracked:
        print("有 profile 数据被 git 跟踪 —— 必须移出索引，并重写历史清除 blob。")
    if verdict_nonempty:
        print("有 profile 含非空真实数据（唯一判据：新建 profile 的这些表为 0 行）。")
    if verdict_external:
        print(f"外部浏览记录 {sum(verdict_external.values())} 条，涉及 {len(verdict_external)} 个站点。")
    if not (verdict_tracked or verdict_nonempty):
        print("都为空 —— 但空也不该提交，仍应删除。")
    return 1


if __name__ == "__main__":
    sys.exit(main())
