# DocumentSaveService — safety design

Implementation: `src-tauri/src/save_service.rs`.
Only entry point from the frontend: the `save_document` Tauri command.
The frontend never opens a file for writing.

---

## 1. Why a Rust-side service

* Least privilege — the WebView has no filesystem write capability at all
  (`src-tauri/capabilities/default.json` grants none).
* One audit point for every write, with stable error codes.
* Testable in isolation: the failure paths can be forced with fault injection
  without needing a GUI.

---

## 2. Pipeline

```
frontend: adapter.serialize()             (commits pending ink first)
   ↓
frontend: adapter.verify(bytes)           (re-open in a fresh PDF.js document)
   ↓   abort here if not parseable — the user's file is still untouched
frontend: base64(bytes)
   ↓ IPC
Rust: save_pdf()
   1. decode base64; require "%PDF-" header
   2. resolve parent directory; require it to exist
   3. writability probe  → SAVE_TARGET_READONLY
   4. create unique temp file *in the target's own directory*
        .paperai-tmp-<pid>-<nanos>-<n>
   5. write_all → flush → sync_all
   6. verify temp: size == expected, "%PDF-" head, "%%EOF" trailer
   7. backup: copy target → <name>.pdf.paperai.bak     (policy flag)
   8. replace:
        if target exists:  rename(target, <name>.pdf.paperai.old)
        rename(temp, target)
        if that fails:     rename(<name>.pdf.paperai.old, target)   [rollback]
        else:              delete <name>.pdf.paperai.old
   9. sha256 of the final file
```

---

## 3. What is guaranteed — and what is not

Honest boundaries:

| Claim | Reality |
|---|---|
| "Atomic replace" | **No.** Windows `MoveFile`/`rename` cannot overwrite an existing file, so the operation is necessarily two renames. A crash between them leaves `<name>.pdf.paperai.old` holding the previous content — recoverable, but not atomic. |
| "Cross-volume safe" | The temp file is created **in the target's own directory**, so both renames stay on one volume. |
| "Crash safe" | Best effort: the original is preserved as `.old` until the new file is in place. We do not use `MoveFileEx` with `MOVEFILE_WRITE_THROUGH` or a transaction (TxF is deprecated). |
| "Locked target" | Detected by attempting the rename; reported as `SAVE_TARGET_LOCKED` with the original left intact. Windows does not let us un-hold another process's handle. |
| Network / UNC paths | Not specially handled. Writes are attempted like any path and failures surface as `IO`/`SAVE_TARGET_LOCKED`. Atomicity on network filesystems is explicitly **not** guaranteed. |

## 4. Error codes

| Code | Meaning | Original file |
|---|---|---|
| `save_no_data` | empty / undecodable payload | untouched |
| `save_no_parent_dir` | target directory missing | untouched |
| `save_target_readonly` | read-only attribute or no write access | untouched |
| `save_temp_create` | temp file could not be created | untouched |
| `save_temp_write` | write/flush/sync failed | untouched |
| `save_temp_invalid` | temp file failed the PDF sanity check | untouched |
| `save_backup` | could not copy the original aside | untouched |
| `save_target_locked` | target could not be moved (held by another process) | untouched |
| `save_replace` | final rename failed, original restored | restored |
| `save_restore_failed` | final rename failed **and** rollback failed | original is at `<name>.pdf.paperai.old` |
| `save_injected_fault` | test-only fault injection | untouched |

`dirty` is cleared **only** on `ok: true`. A failed save always leaves the
document marked dirty.

---

## 5. Fault injection

`SaveRequest.inject_failure` accepts `temp_create`, `temp_write`, `replace`,
`target_readonly`. It is honoured **only** when the process environment has
`PAPERAI_ALLOW_FAULT_INJECTION=1`; otherwise the request is rejected with
`save_injection_disabled`. A production build therefore cannot be tricked into
destroying a document.

---

## 6. Backup policy

* Default `make_backup: true` → one generation: `<name>.pdf.paperai.bak`.
* The caller may disable it; the PoC always passes `true`.
* No timed/background autosave exists and none will run without an explicit
  user action.

---

## 7. Dirty-state rules

* Creating or deleting a highlight / ink sets `dirty`.
* **An uncommitted ink stroke also counts as dirty** — `PdfjsAdapter.isDirty`
  ORs the editor-dirty flag with `pendingInkExists()`.
* Close, switching documents, and single-instance hand-off all prompt
  **保存 / 不保存 / 取消**; "取消" genuinely aborts the action.
* A new path/name is written into app state only after the save reports success.

---

## 8. Logging

Errors are logged with their code and the temp/backup paths. Log lines never
contain document text, and no file content is ever transmitted anywhere.
