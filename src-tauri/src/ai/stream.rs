//! Incremental Server-Sent Events parser for OpenAI-compatible streams.
//!
//! This is a pure state machine so it can be unit-tested without a network.
//! The cases it must survive are exactly the ones that break naive
//! `chunk.split("\n")` implementations:
//!
//! 1. one `data:` line split across several network chunks;
//! 2. several SSE events inside a single chunk;
//! 3. multi-byte UTF-8 (Chinese) split across a chunk boundary;
//! 4. CRLF and LF, comment lines (`:`), and blank-line event separators;
//! 5. `choices` absent, empty, or carrying `delta.content == null`;
//! 6. usage-only trailing chunks;
//! 7. `data: [DONE]` termination, and a stream that just stops;
//! 8. provider error objects delivered mid-stream.

use serde::Deserialize;

/// One decoded outcome from the byte stream.
#[derive(Debug, Clone, PartialEq)]
pub enum SseEvent {
    /// A `data:` payload that parsed as an OpenAI-compatible chunk.
    Chunk(Chunk),
    /// `data: [DONE]`
    Done,
}

/// The parts of an OpenAI-compatible stream chunk we actually use.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Chunk {
    pub content: Option<String>,
    pub finish_reason: Option<String>,
    /// Model echoed by the provider, when present.
    pub model: Option<String>,
    /// An error object delivered inside the stream.
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    /// True when this chunk carried no choices at all (usage-only tail).
    pub usage_only: bool,
}

#[derive(Deserialize)]
struct RawChunk {
    #[serde(default)]
    choices: Option<Vec<RawChoice>>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    error: Option<RawError>,
}

#[derive(Deserialize)]
struct RawChoice {
    #[serde(default)]
    delta: Option<RawDelta>,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Deserialize)]
struct RawDelta {
    #[serde(default)]
    content: Option<String>,
}

#[derive(Deserialize)]
struct RawError {
    #[serde(default)]
    code: Option<serde_json::Value>,
    #[serde(default)]
    message: Option<String>,
}

/// Incremental parser. Feed it bytes in any chunking; pull events out.
pub struct SseParser {
    /// Raw bytes not yet consumed. Kept as bytes (not String) so a multi-byte
    /// character split across chunks is not corrupted.
    buf: Vec<u8>,
    /// Set once a terminal event has been produced.
    finished: bool,
    /// Guard against a provider that never sends a newline.
    max_line_bytes: usize,
}

impl Default for SseParser {
    fn default() -> Self {
        Self {
            buf: Vec::new(),
            finished: false,
            max_line_bytes: 4 * 1024 * 1024,
        }
    }
}

impl SseParser {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_finished(&self) -> bool {
        self.finished
    }

    /// Feed a network chunk and collect every complete event it produced.
    pub fn push(&mut self, bytes: &[u8]) -> Vec<SseEvent> {
        if self.finished {
            return Vec::new();
        }
        self.buf.extend_from_slice(bytes);
        self.drain()
    }

    /// Signal that the socket closed. Emits nothing extra — the caller decides
    /// whether a missing `[DONE]` counts as success (it does, once a chunk has
    /// been seen) or as a truncation.
    pub fn finish(&mut self) -> Vec<SseEvent> {
        let mut out = self.drain();
        // A final event without a trailing newline still counts.
        if !self.finished && !self.buf.is_empty() {
            let tail = std::mem::take(&mut self.buf);
            out.extend(self.handle_line(&tail));
        }
        out
    }

    fn drain(&mut self) -> Vec<SseEvent> {
        let mut out = Vec::new();
        loop {
            let pos = match self.buf.iter().position(|&b| b == b'\n') {
                Some(p) => p,
                None => {
                    if self.buf.len() > self.max_line_bytes {
                        // A provider that never terminates a line: treat the
                        // buffered data as a line rather than growing forever.
                        let line = std::mem::take(&mut self.buf);
                        out.extend(self.handle_line(&line));
                    }
                    break;
                }
            };
            let line: Vec<u8> = self.buf.drain(..=pos).collect();
            out.extend(self.handle_line(&line));
            if self.finished {
                self.buf.clear();
                break;
            }
        }
        out
    }

    /// Parse one line (with its trailing newline).
    fn handle_line(&mut self, line: &[u8]) -> Vec<SseEvent> {
        // Trim CR / LF; keep the rest as raw bytes so UTF-8 stays intact.
        let mut end = line.len();
        while end > 0 && (line[end - 1] == b'\n' || line[end - 1] == b'\r') {
            end -= 1;
        }
        let line = &line[..end];

        // Blank line = event separator; comment line starts with ':'.
        if line.is_empty() || line[0] == b':' {
            return Vec::new();
        }

        // Only `data:` carries payload in the dialect we support. `event:`,
        // `id:` and `retry:` are ignored on purpose.
        let payload = match line.strip_prefix(b"data:") {
            Some(p) => p,
            None => return Vec::new(),
        };
        // A single optional leading space after the colon, per the SSE spec.
        let payload = payload.strip_prefix(b" ").unwrap_or(payload);

        if payload == b"[DONE]" {
            self.finished = true;
            return vec![SseEvent::Done];
        }

        let text = match std::str::from_utf8(payload) {
            Ok(t) => t,
            Err(_) => {
                // Should not happen for valid SSE; drop the line rather than
                // emitting a replacement character into the answer.
                return Vec::new();
            }
        };

        match serde_json::from_str::<RawChunk>(text) {
            Ok(raw) => vec![SseEvent::Chunk(convert(raw))],
            Err(_) => {
                // Non-JSON payload: some gateways send keep-alive text. Ignore
                // it rather than breaking the stream.
                Vec::new()
            }
        }
    }
}

fn convert(raw: RawChunk) -> Chunk {
    let mut c = Chunk {
        model: raw.model,
        ..Default::default()
    };

    if let Some(err) = raw.error {
        c.error_code = Some(match err.code {
            Some(serde_json::Value::String(s)) => s,
            Some(serde_json::Value::Number(n)) => n.to_string(),
            Some(other) => other.to_string(),
            None => "provider_error".to_string(),
        });
        c.error_message = err.message;
        return c;
    }

    match raw.choices {
        None => c.usage_only = true,
        Some(choices) if choices.is_empty() => c.usage_only = true,
        Some(choices) => {
            // We only ever request n = 1, but handle a list defensively.
            for ch in choices {
                if let Some(d) = ch.delta {
                    if let Some(t) = d.content {
                        if !t.is_empty() {
                            c.content = Some(match c.content.take() {
                                Some(prev) => prev + &t,
                                None => t,
                            });
                        }
                    }
                }
                if ch.finish_reason.is_some() {
                    c.finish_reason = ch.finish_reason;
                }
            }
        }
    }
    c
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(evs: &[SseEvent]) -> String {
        evs.iter()
            .filter_map(|e| match e {
                SseEvent::Chunk(c) => c.content.clone(),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn single_event() {
        let mut p = SseParser::new();
        let evs = p.push(b"data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}\n\n");
        assert_eq!(texts(&evs), "Hello");
    }

    #[test]
    fn data_split_across_chunks() {
        let mut p = SseParser::new();
        assert!(p.push(b"data: {\"choi").is_empty());
        assert!(p.push(b"ces\":[{\"delta\":{\"cont").is_empty());
        let evs = p.push(b"ent\":\"Hi\"}}]}\n\n");
        assert_eq!(texts(&evs), "Hi");
    }

    #[test]
    fn several_events_in_one_chunk() {
        let mut p = SseParser::new();
        let evs = p.push(
            b"data: {\"choices\":[{\"delta\":{\"content\":\"a\"}}]}\n\
              data: {\"choices\":[{\"delta\":{\"content\":\"b\"}}]}\n\
              data: {\"choices\":[{\"delta\":{\"content\":\"c\"}}]}\n",
        );
        assert_eq!(texts(&evs), "abc");
    }

    #[test]
    fn utf8_split_across_chunks() {
        // "中文" split in the middle of a 3-byte character.
        let payload = "data: {\"choices\":[{\"delta\":{\"content\":\"中文\"}}]}\n\n".as_bytes().to_vec();
        let cut = payload.len() - 8; // lands inside the closing braces / CJK area
        let mut p = SseParser::new();
        let mut got = String::new();
        got += &texts(&p.push(&payload[..cut]));
        got += &texts(&p.push(&payload[cut..]));
        assert_eq!(got, "中文");
    }

    #[test]
    fn crlf_and_lf_both_work() {
        let mut p = SseParser::new();
        let evs = p.push(b"data: {\"choices\":[{\"delta\":{\"content\":\"X\"}}]}\r\n\r\n");
        assert_eq!(texts(&evs), "X");
    }

    #[test]
    fn comments_and_unknown_fields_ignored() {
        let mut p = SseParser::new();
        let evs = p.push(b": keep-alive\nevent: message\nid: 7\ndata: {\"choices\":[{\"delta\":{\"content\":\"k\"}}]}\n\n");
        assert_eq!(texts(&evs), "k");
    }

    #[test]
    fn null_content_and_usage_only_are_not_errors() {
        let mut p = SseParser::new();
        let evs = p.push(
            b"data: {\"choices\":[{\"delta\":{\"content\":null}}]}\n\n\
              data: {\"choices\":[],\"usage\":{\"total_tokens\":9}}\n\n\
              data: {\"usage\":{\"total_tokens\":9}}\n\n",
        );
        assert_eq!(texts(&evs), "");
        assert!(p.is_finished() == false);
        // All three parsed as chunks without an error being raised.
        assert_eq!(evs.len(), 3);
    }

    #[test]
    fn done_terminates_and_stops_parsing() {
        let mut p = SseParser::new();
        let evs = p.push(b"data: {\"choices\":[{\"delta\":{\"content\":\"z\"}}]}\n\ndata: [DONE]\n\n");
        assert_eq!(texts(&evs), "z");
        assert!(evs.iter().any(|e| matches!(e, SseEvent::Done)));
        assert!(p.is_finished());
        // Anything after DONE is ignored.
        assert!(p.push(b"data: {\"choices\":[{\"delta\":{\"content\":\"late\"}}]}\n").is_empty());
    }

    #[test]
    fn finish_reason_is_captured() {
        let mut p = SseParser::new();
        let evs = p.push(b"data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n");
        match &evs[0] {
            SseEvent::Chunk(c) => assert_eq!(c.finish_reason.as_deref(), Some("stop")),
            _ => panic!("expected chunk"),
        }
    }

    #[test]
    fn in_stream_error_object_is_surfaced() {
        let mut p = SseParser::new();
        let evs = p.push(b"data: {\"error\":{\"code\":\"rate_limit\",\"message\":\"slow down\"}}\n\n");
        match &evs[0] {
            SseEvent::Chunk(c) => {
                assert_eq!(c.error_code.as_deref(), Some("rate_limit"));
                assert_eq!(c.error_message.as_deref(), Some("slow down"));
            }
            _ => panic!("expected chunk"),
        }
    }

    #[test]
    fn abrupt_close_without_done_still_yields_content() {
        let mut p = SseParser::new();
        let evs = p.push(b"data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n");
        assert_eq!(texts(&evs), "partial");
        assert!(!p.is_finished());
        // The caller distinguishes "no [DONE]" from an error; the parser just
        // reports that it never saw a terminal event.
        assert!(p.finish().is_empty());
    }

    #[test]
    fn trailing_line_without_newline_is_flushed() {
        let mut p = SseParser::new();
        assert!(p.push(b"data: {\"choices\":[{\"delta\":{\"content\":\"tail\"}}]}").is_empty());
        assert_eq!(texts(&p.finish()), "tail");
    }

    #[test]
    fn multiple_choices_are_concatenated_defensively() {
        let mut p = SseParser::new();
        let evs = p.push(
            b"data: {\"choices\":[{\"delta\":{\"content\":\"one\"}},{\"delta\":{\"content\":\"two\"}}]}\n\n",
        );
        assert_eq!(texts(&evs), "onetwo");
    }
}
