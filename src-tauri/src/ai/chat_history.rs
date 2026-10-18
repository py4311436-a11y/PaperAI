//! Per-document chat history, stored beside the PDF.
//!
//! Why beside the PDF and not in app data: the conversation is *about* that
//! paper. Moving or renaming the pair together keeps them together, and a
//! document copied to another machine carries its own history. The reading notes
//! already work this way.
//!
//! Two files, not one:
//!
//! ```text
//! paper.pdf
//! paper.pdf.paperai-notes.md     <- reading notes (existing)
//! paper.pdf.paperai-chat.json    <- turns, timestamps, attachment references
//! paper.pdf.paperai-chat/        <- the images themselves
//! ```
//!
//! The images are files rather than base64 inside the JSON for two reasons. A
//! seven-page conversation is ~5 MB of data URLs, and JSON that size is slow to
//! parse, impossible to inspect in an editor, and rewritten in full on every
//! turn. And as separate files they can be **content-addressed**: the same page
//! image appearing in several turns is stored once, so a long conversation about
//! one paper does not grow linearly with its own length.

use std::fs;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use sha2::{Digest, Sha256};

use crate::error::{codes, AppError, AppResult};

/// Suffix for the JSON sidecar.
const CHAT_SUFFIX: &str = ".paperai-chat.json";
/// Suffix for the directory holding the images.
const IMAGE_DIR_SUFFIX: &str = ".paperai-chat";

/// Ceiling on one stored image, matching what the app will send.
const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;
/// Ceiling on one decoded request. Rust rejects past this before writing
/// anything, so a runaway conversation cannot fill the disk.
const MAX_TOTAL_BYTES: usize = 64 * 1024 * 1024;

/// `论文.pdf` -> `论文.pdf.paperai-chat.json`, in the same directory.
pub fn chat_path_for(pdf: &Path) -> AppResult<PathBuf> {
    sidecar(pdf, CHAT_SUFFIX)
}

/// `论文.pdf` -> `论文.pdf.paperai-chat/`.
pub fn image_dir_for(pdf: &Path) -> AppResult<PathBuf> {
    sidecar(pdf, IMAGE_DIR_SUFFIX)
}

fn sidecar(pdf: &Path, suffix: &str) -> AppResult<PathBuf> {
    let name = pdf
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| AppError::new(codes::AI_BAD_CONFIG, "无法确定文档文件名"))?;
    if name.trim().is_empty() {
        return Err(AppError::new(codes::AI_BAD_CONFIG, "文档文件名无效"));
    }
    let mut path = pdf.parent().map(Path::to_path_buf).unwrap_or_default();
    path.push(format!("{name}{suffix}"));
    Ok(path)
}

/// Read a document's history, with attachments inlined as data URLs again.
///
/// Returns `None` when the document has no history. A file that exists but is
/// not valid JSON is an **error**, not an empty history: silently starting fresh
/// would let the next save overwrite whatever is there.
pub fn read_chat(pdf: &Path) -> AppResult<Option<serde_json::Value>> {
    let json_path = chat_path_for(pdf)?;
    if !json_path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&json_path)
        .map_err(|e| AppError::new(codes::AI_INTERNAL, format!("读取对话历史失败：{e}")))?;
    let mut doc: serde_json::Value = serde_json::from_str(&raw).map_err(|e| {
        AppError::new(
            codes::AI_BAD_CONFIG,
            format!(
                "{} 已存在，但不是有效的 PaperAI 对话历史，已拒绝读写以免覆盖你的内容：{e}",
                json_path.display()
            ),
        )
    })?;

    // Turn `{"file": "abc.jpg", ...}` back into `{"dataUrl": "data:...", ...}`.
    // A missing image is dropped rather than failing the whole read: the text of
    // the conversation is still worth showing, and one deleted file should not
    // make a document unopenable.
    let dir = image_dir_for(pdf)?;
    if let Some(turns) = doc.get_mut("turns").and_then(|t| t.as_array_mut()) {
        for turn in turns.iter_mut() {
            let Some(list) = turn.get_mut("attachments").and_then(|a| a.as_array_mut()) else {
                continue;
            };
            let mut kept: Vec<serde_json::Value> = Vec::with_capacity(list.len());
            for mut att in list.drain(..) {
                let Some(file) = att.get("file").and_then(|f| f.as_str()) else {
                    continue;
                };
                // Only ever read our own filenames — never a path from the JSON,
                // which could otherwise point anywhere.
                if file.contains('/') || file.contains('\\') || file.contains("..") {
                    continue;
                }
                let path = dir.join(file);
                let Ok(bytes) = fs::read(&path) else { continue };
                let mime = mime_for(&path);
                let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                if let Some(obj) = att.as_object_mut() {
                    obj.insert(
                        "dataUrl".into(),
                        serde_json::Value::String(format!("data:{mime};base64,{b64}")),
                    );
                }
                kept.push(att);
            }
            if let Some(obj) = turn.as_object_mut() {
                obj.insert("attachments".into(), serde_json::Value::Array(kept));
            }
        }
    }
    Ok(Some(doc))
}

/// Write a document's history, storing attachments as content-addressed files.
///
/// The caller sends attachments as `dataUrl`; this decodes each one, names it by
/// the SHA-256 of its bytes, writes it if it is not already there, and rewrites
/// the entry to `{"file": "<hash>.jpg", ...}`. Two turns carrying the same page
/// therefore share one file on disk.
pub fn write_chat(pdf: &Path, mut doc: serde_json::Value) -> AppResult<serde_json::Value> {
    let json_path = chat_path_for(pdf)?;
    let dir = image_dir_for(pdf)?;

    let turns = doc
        .get_mut("turns")
        .and_then(|t| t.as_array_mut())
        .ok_or_else(|| AppError::new(codes::AI_BAD_CONFIG, "对话历史缺少 turns 数组"))?;

    let mut total = 0usize;
    let mut pending: Vec<(PathBuf, Vec<u8>)> = Vec::new();

    for turn in turns.iter_mut() {
        let Some(list) = turn.get_mut("attachments").and_then(|a| a.as_array_mut()) else {
            continue;
        };
        let mut rewritten: Vec<serde_json::Value> = Vec::with_capacity(list.len());
        for mut att in list.drain(..) {
            let Some(url) = att.get("dataUrl").and_then(|u| u.as_str()) else {
                // Already a reference (loaded from disk and unchanged): keep it.
                if att.get("file").is_some() {
                    rewritten.push(att);
                }
                continue;
            };
            let (mime, bytes) = decode_data_url(url)?;
            if bytes.len() > MAX_IMAGE_BYTES {
                return Err(AppError::new(
                    codes::AI_BAD_CONFIG,
                    format!("单张图片超过 {} MiB，未保存", MAX_IMAGE_BYTES / 1024 / 1024),
                ));
            }
            total += bytes.len();
            if total > MAX_TOTAL_BYTES {
                return Err(AppError::new(
                    codes::AI_BAD_CONFIG,
                    format!(
                        "对话中的图片总计超过 {} MiB，未保存",
                        MAX_TOTAL_BYTES / 1024 / 1024
                    ),
                ));
            }
            let name = format!("{}.{}", short_hash(&bytes), ext_for(&mime));
            let path = dir.join(&name);
            if !path.exists() {
                pending.push((path, bytes));
            }
            if let Some(obj) = att.as_object_mut() {
                obj.remove("dataUrl");
                obj.insert("file".into(), serde_json::Value::String(name));
            }
            rewritten.push(att);
        }
        if let Some(obj) = turn.as_object_mut() {
            obj.insert("attachments".into(), serde_json::Value::Array(rewritten));
        }
    }

    // Only touch the disk once every image decoded: a failure halfway through
    // would otherwise leave a directory of files no JSON refers to.
    if !pending.is_empty() {
        fs::create_dir_all(&dir).map_err(|e| {
            AppError::new(codes::AI_INTERNAL, format!("创建对话图片目录失败：{e}"))
        })?;
        for (path, bytes) in pending {
            fs::write(&path, bytes)
                .map_err(|e| AppError::new(codes::AI_INTERNAL, format!("写入图片失败：{e}")))?;
        }
    }

    let body = serde_json::to_string_pretty(&doc)
        .map_err(|e| AppError::new(codes::AI_INTERNAL, format!("序列化对话历史失败：{e}")))?;
    // Write-then-rename so a crash mid-write cannot leave a truncated JSON that
    // the next open refuses to parse.
    let tmp = json_path.with_extension("json.tmp");
    fs::write(&tmp, body.as_bytes())
        .map_err(|e| AppError::new(codes::AI_INTERNAL, format!("写入对话历史失败：{e}")))?;
    fs::rename(&tmp, &json_path)
        .map_err(|e| AppError::new(codes::AI_INTERNAL, format!("保存对话历史失败：{e}")))?;

    Ok(doc)
}

/// Delete a document's stored conversation, images included.
pub fn clear_chat(pdf: &Path) -> AppResult<()> {
    let json_path = chat_path_for(pdf)?;
    let dir = image_dir_for(pdf)?;
    if json_path.exists() {
        fs::remove_file(&json_path)
            .map_err(|e| AppError::new(codes::AI_INTERNAL, format!("删除对话历史失败：{e}")))?;
    }
    if dir.exists() {
        // Only files this module writes, so a user's own folder is not removed.
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_file() && p.extension().is_some() {
                    let _ = fs::remove_file(p);
                }
            }
        }
        let _ = fs::remove_dir(&dir);
    }
    Ok(())
}

fn decode_data_url(url: &str) -> AppResult<(String, Vec<u8>)> {
    let rest = url
        .strip_prefix("data:")
        .ok_or_else(|| AppError::new(codes::AI_BAD_CONFIG, "图片不是 data URL"))?;
    let (meta, b64) = rest
        .split_once(',')
        .ok_or_else(|| AppError::new(codes::AI_BAD_CONFIG, "图片 data URL 格式错误"))?;
    let mime = meta
        .strip_suffix(";base64")
        .ok_or_else(|| AppError::new(codes::AI_BAD_CONFIG, "图片不是 base64 编码"))?;
    // Only images. The field is called `attachments` and every caller sends
    // images, so anything else is a bug or a probe — and writing an arbitrary
    // payload into a directory named for images is how a storage area becomes a
    // drop box. Refusing here is cheap; auditing it later is not.
    if !mime.starts_with("image/") {
        return Err(AppError::new(
            codes::AI_BAD_CONFIG,
            format!("附件类型 {mime} 不是图片，已拒绝保存"),
        ));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.as_bytes())
        .map_err(|e| AppError::new(codes::AI_BAD_CONFIG, format!("图片 base64 解码失败：{e}")))?;
    Ok((mime.to_string(), bytes))
}

fn ext_for(mime: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/webp" => "webp",
        _ => "jpg",
    }
}

fn mime_for(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        _ => "image/jpeg",
    }
}

fn short_hash(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    let digest = h.finalize();
    // 16 hex chars: collision-free in practice for a folder of page images, and
    // short enough to read in a file listing.
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tmp_pdf(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("paperai-chat-{}-{}", std::process::id(), name));
        let _ = fs::create_dir_all(&dir);
        dir.join("paper.pdf")
    }

    const PNG: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    fn doc_with_one_image(pdf: &Path, url: &str) -> serde_json::Value {
        json!({
            "version": 1,
            "documentTitle": "paper.pdf",
            "turns": [{
                "id": "t1",
                "role": "user",
                "content": "这是什么",
                "createdAt": "2026-10-18T19:35:12+08:00",
                "attachments": [{
                    "id": "a1", "dataUrl": url, "page": 3,
                    "width": 10, "height": 10, "source": "page"
                }]
            }]
        })
    }

    #[test]
    fn sidecar_paths_sit_beside_the_pdf() {
        let pdf = PathBuf::from("D:/papers/paper.pdf");
        assert!(chat_path_for(&pdf).unwrap().ends_with("paper.pdf.paperai-chat.json"));
        assert!(image_dir_for(&pdf).unwrap().ends_with("paper.pdf.paperai-chat"));
    }

    #[test]
    fn a_document_with_no_history_reads_as_none() {
        let pdf = tmp_pdf("none");
        assert!(read_chat(&pdf).unwrap().is_none());
    }

    #[test]
    fn an_image_is_written_once_and_read_back_as_a_data_url() {
        let pdf = tmp_pdf("roundtrip");
        let _ = clear_chat(&pdf);
        write_chat(&pdf, doc_with_one_image(&pdf, PNG)).unwrap();

        // On disk the attachment is a filename, not base64.
        let raw = fs::read_to_string(chat_path_for(&pdf).unwrap()).unwrap();
        assert!(!raw.contains("base64"), "JSON must not carry the payload");
        assert!(raw.contains("\"file\""), "it must carry a reference: {raw}");

        let back = read_chat(&pdf).unwrap().unwrap();
        let att = &back["turns"][0]["attachments"][0];
        assert_eq!(att["dataUrl"], json!(PNG), "round-trips byte for byte");
        assert_eq!(att["page"], json!(3), "and keeps the page it came from");
        let _ = clear_chat(&pdf);
    }

    #[test]
    fn the_same_image_in_two_turns_is_stored_once() {
        // The reason images are content-addressed: a conversation that sends the
        // same page twice must not double the size on disk.
        let pdf = tmp_pdf("dedupe");
        let _ = clear_chat(&pdf);
        let mut doc = doc_with_one_image(&pdf, PNG);
        let second = doc["turns"][0].clone();
        doc["turns"].as_array_mut().unwrap().push(second);

        let saved = write_chat(&pdf, doc).unwrap();
        let a = saved["turns"][0]["attachments"][0]["file"].as_str().unwrap().to_string();
        let b = saved["turns"][1]["attachments"][0]["file"].as_str().unwrap().to_string();
        assert_eq!(a, b, "same bytes must share one file");

        let files: Vec<_> = fs::read_dir(image_dir_for(&pdf).unwrap())
            .unwrap()
            .flatten()
            .collect();
        assert_eq!(files.len(), 1, "one file on disk");
        let _ = clear_chat(&pdf);
    }

    #[test]
    fn a_turn_without_attachments_is_preserved() {
        let pdf = tmp_pdf("plain");
        let _ = clear_chat(&pdf);
        let doc = json!({
            "version": 1,
            "turns": [{"id": "t1", "role": "assistant", "content": "答案",
                       "createdAt": "2026-10-18T19:40:00+08:00"}]
        });
        write_chat(&pdf, doc).unwrap();
        let back = read_chat(&pdf).unwrap().unwrap();
        assert_eq!(back["turns"][0]["content"], json!("答案"));
        assert_eq!(
            back["turns"][0]["createdAt"],
            json!("2026-10-18T19:40:00+08:00"),
            "timestamps survive"
        );
        let _ = clear_chat(&pdf);
    }

    #[test]
    fn a_missing_image_file_does_not_make_the_history_unreadable() {
        // One deleted file must not cost the user the whole conversation.
        let pdf = tmp_pdf("missing");
        let _ = clear_chat(&pdf);
        write_chat(&pdf, doc_with_one_image(&pdf, PNG)).unwrap();

        let dir = image_dir_for(&pdf).unwrap();
        for e in fs::read_dir(&dir).unwrap().flatten() {
            let _ = fs::remove_file(e.path());
        }
        let back = read_chat(&pdf).unwrap().unwrap();
        assert_eq!(back["turns"][0]["content"], json!("这是什么"), "text survives");
        assert_eq!(back["turns"][0]["attachments"].as_array().unwrap().len(), 0);
        let _ = clear_chat(&pdf);
    }

    #[test]
    fn invalid_json_is_an_error_not_an_empty_history() {
        // Silently treating it as empty would let the next save destroy whatever
        // the user has there.
        let pdf = tmp_pdf("badjson");
        let path = chat_path_for(&pdf).unwrap();
        fs::write(&path, b"{not json").unwrap();
        assert!(read_chat(&pdf).is_err());
        let _ = clear_chat(&pdf);
    }

    #[test]
    fn a_path_in_the_json_cannot_read_outside_the_image_directory() {
        let pdf = tmp_pdf("traversal");
        let _ = clear_chat(&pdf);
        fs::create_dir_all(image_dir_for(&pdf).unwrap()).unwrap();
        let doc = json!({
            "version": 1,
            "turns": [{"id":"t1","role":"user","content":"x",
                "attachments":[{"file":"../../../../Windows/win.ini","page":1}]}]
        });
        fs::write(
            chat_path_for(&pdf).unwrap(),
            serde_json::to_string(&doc).unwrap(),
        )
        .unwrap();
        let back = read_chat(&pdf).unwrap().unwrap();
        assert_eq!(
            back["turns"][0]["attachments"].as_array().unwrap().len(),
            0,
            "must not have followed the path"
        );
        let _ = clear_chat(&pdf);
    }

    #[test]
    fn a_non_image_payload_is_refused() {
        let pdf = tmp_pdf("notimage");
        let _ = clear_chat(&pdf);
        let doc = json!({
            "version": 1,
            "turns": [{"id":"t1","role":"user","content":"x",
                "attachments":[{"dataUrl":"data:text/plain;base64,aGk="}]}]
        });
        assert!(write_chat(&pdf, doc).is_err(), "text/plain must not be stored");
        let _ = clear_chat(&pdf);
    }
}
