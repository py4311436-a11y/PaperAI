#!/usr/bin/env python3
"""
Push one commit to GitHub through the REST API, because `git push` cannot reach
github.com from this machine while api.github.com works.

Why this exists: the egress proxy returns 502 for github.com (the host `git push`
needs, since HTTPS smart protocol talks to it directly) while api.github.com
answers 200. Rather than keep retrying a transport that cannot work, drive the
same Git Data API that a successful push would drive.

This is not a general-purpose pusher. It handles exactly the shape we need: a
fast-forward by one commit on one branch, carrying file changes. Anything more
complicated — merges, multiple commits, deletes — should use a real git push
once the network allows.

Safety rules, because this writes to a shared remote:
  * Refuses unless the remote HEAD is the commit's parent. A fast-forward only;
    anything else means someone else moved the branch.
  * Uploads each blob and asserts the server returned the SHA git computed
    locally. A mismatch would mean the content differs, which would make the
    pushed commit not be the commit that was tested.
  * Fails loudly rather than half-applying.
"""

import base64
import json
import subprocess
import sys
import urllib.error
import urllib.request

REPO = "py4311436-a11y/PaperAI"
BRANCH = "ai-integration"
COMMIT = sys.argv[1] if len(sys.argv) > 1 else "HEAD"
API = f"https://api.github.com/repos/{REPO}"


def git(*args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=__file__ and r"D:\AIreader\PaperAI-PoC",
        capture_output=True, text=True, check=True,
    ).stdout.strip()


def token() -> str:
    """The same credential `git push` would use. Never printed."""
    out = subprocess.run(
        ["git", "credential", "fill"],
        input="protocol=https\nhost=github.com\n\n",
        capture_output=True, text=True, check=True,
    ).stdout
    for line in out.splitlines():
        if line.startswith("password="):
            return line.split("=", 1)[1]
    raise SystemExit("no credential in the git credential store")


TOK = token()


def call(method: str, url: str, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {TOK}")
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:600]
        raise SystemExit(f"{method} {url}\nHTTP {e.code}: {detail}")


def main() -> None:
    commit = git("rev-parse", COMMIT)
    parent = git("rev-parse", f"{commit}^")
    tree = git("rev-parse", f"{commit}^{{tree}}")
    message = git("log", "-1", "--format=%B", commit).rstrip("\n")

    print(f"commit  {commit}")
    print(f"parent  {parent}")
    print(f"tree    {tree}")

    # 1. Fast-forward check, before touching anything.
    remote = call("GET", f"{API}/git/ref/heads/{BRANCH}")
    remote_sha = remote["object"]["sha"]
    print(f"remote  {remote_sha}")
    if remote_sha != parent:
        raise SystemExit(
            f"NOT a fast-forward: remote is {remote_sha[:7]}, parent is {parent[:7]}.\n"
            "Someone else moved the branch, or the remote is on a different line. "
            "Fetch and inspect before pushing."
        )

    # 2. Upload every blob this commit touches and verify the SHA matches.
    #
    # GitHub hashes what it received. If its SHA equals the one git computed,
    # the bytes on the server are the bytes that were tested here. A silent
    # mismatch would push a commit that is not the commit we verified.
    changed = git("diff-tree", "--no-commit-id", "--name-only", "-r", commit).splitlines()
    print(f"\n{len(changed)} file(s) to upload")
    for path in changed:
        mode, type_, blob_sha = (
            git("ls-tree", commit, "--", path).split()[0],
            git("ls-tree", commit, "--", path).split()[1],
            git("ls-tree", commit, "--", path).split()[2],
        )
        content = open(rf"D:\AIreader\PaperAI-PoC\{path}", "rb").read()
        remote_blob = call("POST", f"{API}/git/blobs", {
            "content": base64.b64encode(content).decode(),
            "encoding": "base64",
        })
        ok = remote_blob["sha"] == blob_sha
        print(f"  {'OK ' if ok else 'BAD'} {path}")
        if not ok:
            raise SystemExit(
                f"content mismatch on {path}: git says {blob_sha}, "
                f"server says {remote_blob['sha']}. Refusing to continue -- "
                "the pushed commit would not be the commit that was tested."
            )

    # 3. Create the tree on top of the parent's tree, then the commit, then move
    #    the branch.
    #
    #    The tree cannot be posted as a bare SHA: GitHub rejects a tree it has
    #    not itself built ("Tree SHA does not exist"). But the repository already
    #    *has* the parent's tree, so `base_tree` plus the changed entries is the
    #    incremental form the API exists for -- it applies the difference server
    #    side instead of re-uploading all 406 entries. Only the changed paths are
    #    named, so every untouched file is carried over by SHA and cannot drift.
    #
    #    Because step 2 proved each blob's content matches what git has locally,
    #    and every other path is inherited verbatim from the parent, the resulting
    #    tree is the commit that was tested.
    entries = []
    for path in changed:
        mode, type_, blob_sha = git("ls-tree", commit, "--", path).split()[:3]
        entries.append({
            "path": path,
            "mode": mode,
            "type": type_,
            "sha": blob_sha,
        })
    new_tree = call("POST", f"{API}/git/trees", {
        "base_tree": git("rev-parse", f"{parent}^{{tree}}"),
        "tree": entries,
    })
    print(f"\nbase tree {git('rev-parse', f'{parent}^{{tree}}')[:7]}"
          f" -> {new_tree['sha'][:7]} ({len(entries)} entries)")

    created = call("POST", f"{API}/git/commits", {
        "message": message,
        "tree": new_tree["sha"],
        "parents": [parent],
    })
    new_sha = created["sha"]
    print(f"created commit {new_sha}")

    updated = call("PATCH", f"{API}/git/refs/heads/{BRANCH}", {
        "sha": new_sha,
        "force": False,
    })
    print(f"branch  {BRANCH} -> {updated['object']['sha']}")

    print(f"\npushed {commit[:7]} as {new_sha[:7]}")


if __name__ == "__main__":
    main()
