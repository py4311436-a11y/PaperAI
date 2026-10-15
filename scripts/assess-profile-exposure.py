#!/usr/bin/env python3
"""Assess the severity of the committed Edge profile data.

Answers three questions, and prints no secret material:
  1. Is `Local State` (which holds the key material that protects the saved
     passwords) also inside the committed directories?
  2. Are the stored password blobs encrypted, or plaintext?  (Chromium tags
     them with a version prefix; printing the 3-char tag reveals nothing.)
  3. Are the profile files hardlinks / copies of the real Edge profile?
"""

import os
import sqlite3
import subprocess
import sys

REPO = r"D:\AIreader\PaperAI-PoC"
REAL = os.path.join(os.environ["LOCALAPPDATA"], "Microsoft", "Edge", "User Data")

def tracked():
    out = subprocess.run(
        ["git", "ls-files"], cwd=REPO, capture_output=True, text=True
    ).stdout
    return [l for l in out.splitlines() if l]

files = tracked()

print("=== 1. 被跟踪文件里是否有 Local State（存放解密密钥） ===")
ls_tracked = [f for f in files if os.path.basename(f) == "Local State"]
print(f"  Local State 被跟踪: {'是 -> ' + str(ls_tracked) if ls_tracked else '否'}")
ls_candidates = [
    f for f in files if "profile" in f and ("Local State" in f or "local_state" in f.lower())
]
print(f"  任何名称含 Local State 的: {ls_candidates or '无'}")

print("\n=== 2. 密码字段是密文还是明文 ===")
for dirpath, _d, _f in os.walk(os.path.join(REPO, "evidence")):
    if not dirpath.replace("\\", "/").endswith("-profile"):
        continue
    p = os.path.join(dirpath, "Default", "Login Data")
    if not os.path.exists(p):
        continue
    name = os.path.basename(dirpath)
    con = sqlite3.connect(f"file:{p}?mode=ro&immutable=1", uri=True)
    try:
        rows = con.execute("SELECT password_value FROM logins").fetchall()
    finally:
        con.close()
    tags = {}
    for (blob,) in rows:
        if not blob:
            tags["(empty)"] = tags.get("(empty)", 0) + 1
            continue
        raw = bytes(blob)
        # Chromium prefixes the blob with a version tag, then the ciphertext.
        tag = raw[:3]
        t = tag.decode("ascii", "replace") if tag[:1] == b"v" else "(binary)"
        tags[t] = tags.get(t, 0) + 1
    pretty = ", ".join(f"{k}={v}" for k, v in sorted(tags.items()))
    print(f"  {name}: {pretty}   [v10/v20 = DPAPI/AES-GCM 密文, 非明文]")

print("\n=== 3. 这些文件是否与真实 Edge profile 相同（硬链接/副本） ===")
real_login = os.path.join(REAL, "Default", "Login Data")
print(f"  真实 profile 存在: {os.path.exists(real_login)}")
if os.path.exists(real_login):
    same_inode = []
    for dirpath, _d, _f in os.walk(os.path.join(REPO, "evidence")):
        if not dirpath.replace("\\", "/").endswith("-profile"):
            continue
        cand = os.path.join(dirpath, "Default", "Login Data")
        if not os.path.exists(cand):
            continue
        try:
            a = os.stat(cand)
            b = os.stat(real_login)
            same_inode.append(
                (os.path.basename(dirpath), a.st_ino == b.st_ino, a.st_nlink)
            )
        except OSError as e:
            same_inode.append((os.path.basename(dirpath), f"err {e}", "?"))
    for name, same, nl in same_inode:
        print(f"  {name}: 与真实文件同 inode={same} 硬链接数={nl}")
    # How many logins does the REAL profile have?
    try:
        con = sqlite3.connect(f"file:{real_login}?mode=ro&immutable=1", uri=True)
        n = con.execute("SELECT COUNT(*) FROM logins").fetchone()[0]
        con.close()
        print(f"  真实 profile 的 logins 行数: {n}")
    except sqlite3.Error as e:
        print(f"  真实 profile 读取失败（正常，Edge 可能在运行）: {e}")
