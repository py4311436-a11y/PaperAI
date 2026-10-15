# Repository security audit — is it safe to share this?

Raised by the question: *"if someone else installs this, will my DeepSeek API
key leak?"* The answer has two halves, and they are opposite.

| Surface | Verdict |
|---|---|
| The installer (`release/PaperAI_0.3.1_x64-setup.exe`) | **Clean — verified byte-for-byte** |
| The project repository | **WAS leaking real browser credentials. Found and removed.** |

---

## 1. The installer is clean

### Where the key actually lives

`PaperAI/AIProvider/<profile_id>` in **Windows Credential Manager**, scoped to
the Windows user account. It is not in `ai-profiles.json`, not in the log, and
not in any file the app writes.

### Verifying it, rather than asserting it

Added `src-tauri/src/ai/secrets.rs::sharing_audit`, run before handing a build
to anyone:

```bash
cd src-tauri
cargo test --lib -- --ignored --nocapture shipped_artifacts
```

It reads the **real** stored credential and searches every file a recipient
could receive for those exact bytes. The key is never printed and never written
to disk — only its length, and the count of files checked.

Result on this machine:

```
auditing 1 secret(s); deepseek -> 35 bytes, target PaperAI/AIProvider/deepseek
largest files in the scan set:
      11681450  release\PaperAI_0.2.0_x64-setup.exe
       8475136  D:\Program Files\PaperAI\PaperAI.exe
       5726436  release\PaperAI_0.3.0_x64-setup.exe
       4988260  release\PaperAI_0.3.1_x64-setup.exe
       2229713  dist\assets\pdf.worker-*.mjs
scanned 257 file(s), 37346360 bytes total (35.6 MiB)
PASS: none of the 257 file(s) contain any stored key.
```

The scan set deliberately includes **the app's own log** — a log is the classic
accidental leak, and users attach logs to bug reports. `paperai.log` contains
only `argv = [...]` lines (file paths). No key, no `Authorization` header.

### The detector is proven to work

`the_scanner_detects_a_planted_key` plants a synthetic secret in a temp file and
asserts the scanner finds it. A detector that cannot fail reports a PASS that
means nothing. This test runs with the normal suite.

---

## 2. The repository WAS leaking — and it was my fault

The Phase 2 CDP experiments launched Edge with `--user-data-dir` pointing inside
`evidence/`. Those directories accumulated **real browser profile data**, and
**1477 files were committed**:

* `Login Data` — **267 saved-credential rows**, 234 with non-empty usernames,
  250 with non-empty password blobs
* `Cookies`, `History`, `Web Data`, Autofill
* `Local State` — the file carrying the **key material that protects those blobs**
* A second, untracked profile held **2919 real browsing entries across 276 sites**

### How we know this was real data, not seeded filler

A newly created Edge profile was launched into a temp directory and its
databases counted: **0 cookies, 0 logins, 0 history rows.** Since the committed
profiles held 267 logins, those rows came from somewhere real. This is the whole
argument — a structural claim ("these look like defaults") would have been
guesswork, so it was tested.

### Severity, stated precisely

* The password blobs are tagged `v10` — **DPAPI ciphertext tied to the Windows
  account**, not plaintext. Copied to another machine or user they are not
  directly readable.
* **But** the `Local State` file that holds the protecting key was committed
  alongside them, and the plaintext metadata (origins, usernames, browsing
  history) is readable as-is.
* Ciphertext plus its key file does not belong in a repository.

### Before deleting anything

Checked that none of the directories was a symlink or junction — deleting what
looks like a copy would otherwise destroy the real profile. All were plain
directories. The user's actual Edge profile
(`%LOCALAPPDATA%\Microsoft\Edge\User Data\Default`, including `Bookmarks`) was
confirmed intact before and after.

### What was done

1. Removed from the index and from disk: `edge-serve-profile`,
   `edge-gdi2-profile`, `edge-pw-profile` (tracked) and `edge-ctrl-profile`,
   `edge-profile` (untracked but still holding real data). `evidence/` went from
   several hundred MB to 12 MB.
2. `.gitignore` now uses a **catch-all** `*-profile/` plus explicit credential
   database names. The old explicit list is precisely why `edge-serve-profile`
   got through while `edge-ctrl-profile` was covered — enumeration always misses
   one.
3. `scripts/verify-no-profile-data.mjs` (`npm run verify:no-profiles`) fails if
   any profile directory or credential database is tracked **or** present in the
   working tree. Verified in both directions — it catches a planted
   `fake-test-profile/Default/Cookies`.
4. Untracked `evidence/windows-release/user-ai-profiles.before.json`, a copy of
   the user's own provider settings committed only as restore evidence. Its
   SHA-256 stays in the reports; the file does not need to be in git.
5. **Purged git history** (user-approved). `git filter-branch --index-filter`
   across all refs, then `reflog expire` + `gc --prune=now`.

### History purge — verification

Untracking is not removal; the blobs remained retrievable in 13 commits across
`ai-integration`, `master` and `phase2`. After the purge:

| Check | Result |
|---|---|
| Sensitive paths in `git rev-list --objects --all` | **0** |
| `git cat-file -e <branch>:<path>` for 3 samples × 3 branches | **0/9 retrievable** |
| `git log --all -- <profile path>` | empty |
| `git fsck --full` unreachable / dangling | none |
| Loose objects (`count-objects`) | 0 |
| Blobs matching the credential databases' exact sizes | **none present** |

Commit hashes changed. There is **no remote**, so nothing was ever pushed and no
force-push is involved.

> Note on method: grepping the pack file for plaintext strings proves nothing —
> pack contents are zlib-compressed. The size-based object check and
> `rev-list --objects` are the valid tests.

---

## 3. Standing rules

1. **Never** put `--user-data-dir` inside the repository. Use a system temp
   directory and delete it when the process exits.
2. `.gitignore` patterns for scratch data must be **wildcards**, not
   enumerations.
3. Before deleting a directory that holds real data, check whether it is a
   symlink or junction.
4. To decide whether scraped/captured data is "real", **create a clean
   comparison and measure** — do not reason about it.
5. Run both of these before sharing a build or the repository:
   ```bash
   node scripts/verify-no-profile-data.mjs          # repository
   cd src-tauri && cargo test --lib -- --ignored --nocapture shipped_artifacts   # artefacts
   ```
