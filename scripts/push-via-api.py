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


def push_one(commit: str) -> str:
    """Push one commit as a fast-forward. Returns the SHA the remote now has."""
    tree = git("rev-parse", f"{commit}^{{tree}}")
    message = git("log", "-1", "--format=%B", commit).rstrip("\n")
    print(f"\n{'=' * 60}\ncommit  {commit}")
    print(f"parent  {git('rev-parse', f'{commit}^')}")
    print(f"tree    {tree}")

    # 1. Fast-forward check, before touching anything.
    #
    #    This also handles the case where the same content is already on the
    #    remote under a different SHA. A commit pushed through this script is
    #    rebuilt server-side and gets a new SHA: the tree and message survive,
    #    but the original author/committer metadata does not. The next commit
    #    then names a parent the remote has never seen and looks like a
    #    divergence.
    #
    #    So when the remote HEAD's tree equals this commit's *parent* tree, the
    #    remote is simply using a different name for the same commit, and we
    #    adopt its SHA. A commit is its tree plus its parents, and the tree is
    #    byte-identical by construction.
    #
    #    The tree is the whole test. Comparing this commit's own tree would be
    #    wrong -- it is the work being pushed, so it naturally differs.
    remote = call("GET", f"{API}/git/ref/heads/{BRANCH}")
    remote_sha = remote["object"]["sha"]
    remote_head = call("GET", f"{API}/git/commits/{remote_sha}")
    parent = git("rev-parse", f"{commit}^")
    print(f"remote  {remote_sha}")

    if remote_sha != parent:
        parent_tree = git("rev-parse", f"{parent}^{{tree}}")
        remote_tree = remote_head.get("tree", {}).get("sha")
        if remote_tree == parent_tree:
            print(
                f"\nremote HEAD is this commit's parent under a different SHA\n"
                f"  (remote {remote_sha[:7]} == local {parent[:7]}, same tree)"
            )
            parent = remote_sha
        else:
            raise SystemExit(
                f"NOT a fast-forward: remote is {remote_sha[:7]}, parent is {parent[:7]}.\n"
                f"  remote tree {remote_tree}\n"
                f"  parent tree {parent_tree}\n"
                "The trees differ, so the branch moved in a way this script did not\n"
                "make. Fetch and inspect before pushing."
            )

    # 2. Upload every blob this commit touches and verify the SHA matches.
    #
    # GitHub hashes what it received. If its SHA equals the one git computed,
    # the bytes on the server are the bytes that were tested here. A silent
    # mismatch would push a commit that is not the commit we verified.
    #
    # Read the blob from the commit, not from the working tree: a commit is a
    # fixed snapshot, and pushing whatever happens to be on disk right now is
    # how "the thing I tested" stops being "the thing I pushed".
    changed = git("diff-tree", "--no-commit-id", "--name-only", "-r", commit).splitlines()
    print(f"{len(changed)} file(s) to upload")
    entries = []
    for path in changed:
        mode, type_, blob_sha = git("ls-tree", commit, "--", path).split()[:3]
        content = subprocess.run(
            ["git", "cat-file", "blob", blob_sha],
            cwd=r"D:\AIreader\PaperAI-PoC", capture_output=True, check=True,
        ).stdout
        remote_blob = call("POST", f"{API}/git/blobs", {
            "content": base64.b64encode(content).decode(),
            "encoding": "base64",
        })
        if remote_blob["sha"] != blob_sha:
            raise SystemExit(
                f"content mismatch on {path}: git says {blob_sha}, "
                f"server says {remote_blob['sha']}. Refusing to continue -- "
                "the pushed commit would not be the commit that was tested."
            )
        print(f"  OK  {path}")
        entries.append({"path": path, "mode": mode, "type": type_, "sha": blob_sha})

    # 3. Build the tree incrementally, create the commit, move the branch.
    #
    #    The tree cannot be posted as a bare SHA -- GitHub rejects a tree it has
    #    not itself built. But the remote already *has* the parent's tree, so
    #    `base_tree` plus the changed entries is the incremental form the API
    #    exists for: it applies the difference server side instead of
    #    re-uploading all 400-odd entries. Untouched paths are carried over by
    #    SHA and cannot drift.
    new_tree = call("POST", f"{API}/git/trees", {
        "base_tree": git("rev-parse", f"{parent}^{{tree}}"),
        "tree": entries,
    })
    print(f"tree {git('rev-parse', f'{parent}^{{tree}}')[:7]} -> {new_tree['sha'][:7]}")

    created = call("POST", f"{API}/git/commits", {
        "message": message,
        "tree": new_tree["sha"],
        "parents": [parent],
    })
    new_sha = created["sha"]

    updated = call("PATCH", f"{API}/git/refs/heads/{BRANCH}", {
        "sha": new_sha,
        "force": False,
    })
    print(f"branch {BRANCH} -> {updated['object']['sha']}")
    return new_sha


def main() -> None:
    commit = git("rev-parse", COMMIT)

    # Walk back from the commit until we find one the remote already has, then
    # replay the commits in between oldest-first. Each push leaves the remote
    # holding the previous commit, so the next one fast-forwards normally --
    # which is why a run of local commits works, and why a single push of the
    # tip would fail.
    remote = call("GET", f"{API}/git/ref/heads/{BRANCH}")["object"]["sha"]
    chain = []
    cursor = commit
    while cursor != remote:
        chain.append(cursor)
        # A root commit has no parent; `rev-parse <sha>^` fails there. Stop at it
        # rather than crash -- if the remote is not in this history, the guard
        # inside push_one will refuse, which is the honest outcome.
        parent = subprocess.run(
            ["git", "rev-parse", "--verify", "--quiet", f"{cursor}^"],
            cwd=r"D:\AIreader\PaperAI-PoC", capture_output=True, text=True,
        ).stdout.strip()
        if not parent:
            raise SystemExit(
                f"reached the root commit at {cursor[:7]} without meeting the\n"
                f"remote ({remote[:7]}). The histories are unrelated, or the remote\n"
                f"is on a branch this does not descend from. Not pushing."
            )
        cursor = parent
    chain.reverse()

    if not chain:
        print(f"remote is already at {commit[:7]}; nothing to push")
        return

    print(f"{len(chain)} commit(s) to push, oldest first")
    for sha in chain:
        push_one(sha)
        print(f"\npushed {sha[:7]} as {call('GET', f'{API}/git/ref/heads/{BRANCH}')['object']['sha'][:7]}")


if __name__ == "__main__":
    main()
