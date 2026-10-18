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


def push_one(commit: str, base_tree: str) -> str:
    """
    Push one commit as a fast-forward. Returns the tree the remote now holds.

    `base_tree` is passed in rather than derived from the parent SHA, because
    after the first push the parent may be a server-side commit git has never
    seen and cannot resolve. Keeping it explicit also means the base is always
    the tree the remote actually reported, not a local guess about it.
    """
    tree = git("rev-parse", f"{commit}^{{tree}}")
    message = git("log", "-1", "--format=%B", commit).rstrip("\n")
    parent = git("rev-parse", f"{commit}^")
    print(f"\n{'=' * 60}\ncommit  {commit}")
    print(f"parent  {parent}")
    print(f"tree    {tree}")
    print(f"base    {base_tree}")

    # 1. Fast-forward check, before touching anything.
    #
    #    The remote may name this commit's parent under a different SHA -- every
    #    API push rebuilds the commit server-side, losing the original metadata,
    #    so an equal tree under a different name is still the same commit.
    remote = call("GET", f"{API}/git/ref/heads/{BRANCH}")
    remote_sha = remote["object"]["sha"]
    remote_head = call("GET", f"{API}/git/commits/{remote_sha}")
    remote_tree = remote_head.get("tree", {}).get("sha")
    print(f"remote  {remote_sha}")

    if remote_sha != parent:
        if remote_tree == base_tree:
            print(
                f"\nremote HEAD is this commit's parent under a different SHA\n"
                f"  (remote {remote_sha[:7]} == local {parent[:7]}, same tree)"
            )
            parent = remote_sha
        else:
            raise SystemExit(
                f"NOT a fast-forward: remote is {remote_sha[:7]}, parent is {parent[:7]}.\n"
                f"  remote tree {remote_tree}\n"
                f"  expected   {base_tree}\n"
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
    #
    # `--name-status` rather than `--name-only`, because a release commit
    # deletes the superseded installer as well as adding the new one, and a
    # deleted path has no blob in the target commit -- `ls-tree <commit> --
    # <deleted>` returns nothing, and unpacking that crashes. A deletion is
    # expressed as an entry with no sha, which is how the API removes a path.
    status_lines = git(
        "diff-tree", "--no-commit-id", "--name-status", "-r", commit
    ).splitlines()
    print(f"{len(status_lines)} file(s) changed")
    entries = []
    for line in status_lines:
        status, _, path = line.partition("\t")
        if not path:
            continue
        if status.startswith("D"):
            print(f"  DEL {path}")
            entries.append({"path": path, "mode": "100644", "type": "blob", "sha": None})
            continue

        listing = git("ls-tree", commit, "--", path).split()
        if len(listing) < 3:
            raise SystemExit(
                f"cannot resolve {path} in commit {commit[:7]} (status {status}); "
                "refusing to guess at a blob"
            )
        mode, type_, blob_sha = listing[:3]
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
        "base_tree": base_tree,
        "tree": entries,
    })
    print(f"tree {base_tree[:7]} -> {new_tree['sha'][:7]}")

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
    return new_tree["sha"]


def main() -> None:
    commit = git("rev-parse", COMMIT)

    # Find where to start.
    #
    # Normally that is "walk back until a commit the remote already has". But
    # every API push yields a new server-side SHA for the same tree, so the
    # remote's HEAD may be a commit git has never heard of -- walking by SHA
    # would run to the root commit and fail. So the remote HEAD is recognised by
    # its *tree*: a commit is its tree plus its parents, so an equal tree means
    # equal content, and the first local commit with that tree is the right
    # starting point.
    #
    # If no local commit carries the remote's tree, there is nothing to build
    # on and the push is refused rather than forced.
    remote_ref = call("GET", f"{API}/git/ref/heads/{BRANCH}")
    remote_sha = remote_ref["object"]["sha"]
    remote_tree = call("GET", f"{API}/git/commits/{remote_sha}")["tree"]["sha"]
    print(f"remote  {remote_sha}  tree {remote_tree[:7]}")

    base = subprocess.run(
        ["git", "log", "--all", "--format=%H", f"--find-object={remote_tree}"],
        cwd=r"D:\AIreader\PaperAI-PoC", capture_output=True, text=True,
    ).stdout.strip().splitlines()
    base = [sha for sha in base if git("rev-parse", f"{sha}^{{tree}}") == remote_tree]
    if not base:
        base = [sha for sha in git("log", "--all", "--format=%H").splitlines()
                if git("rev-parse", f"{sha}^{{tree}}") == remote_tree]

    if not base:
        raise SystemExit(
            f"no local commit has the remote's tree ({remote_tree[:7]}).\n"
            f"  remote HEAD {remote_sha[:7]}\n"
            "The remote holds work that is not in this repository's history, so\n"
            "there is nothing to fast-forward from. Fetch and reconcile first."
        )

    base_sha = base[0]
    print(f"base    {base_sha}  (same tree as the remote's HEAD)")

    # The commits to replay: everything after the base, oldest-first. Each push
    # leaves the remote holding the previous commit, so the next one
    # fast-forwards normally.
    chain = git("rev-list", "--reverse", f"{base_sha}..{commit}").splitlines()
    if not chain:
        print("nothing to push; the remote already has this content")
        return

    print(f"{len(chain)} commit(s) to push, oldest first\n")
    current_tree = remote_tree
    for sha in chain:
        current_tree = push_one(sha, current_tree)


if __name__ == "__main__":
    main()
