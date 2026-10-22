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
    /// The model's thinking, when the chunk carried some.
    pub reasoning: Option<String>,
    /// Tool-call fragments carried by this chunk.
    ///
    /// A fragment, not a finished call: the protocol streams `id`, `name` and
    /// `arguments` separately, and `arguments` arrives as a series of string
    /// pieces that only form valid JSON once concatenated. Nothing here decides
    /// what a call means — that is the accumulator's job.
    pub tool_calls: Vec<ToolCallDelta>,
}

/// One `delta.tool_calls[i]` fragment, as it arrives.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ToolCallDelta {
    /// Position in the assistant message's array. The only stable identifier
    /// while streaming: `id` is itself a fragment on the first chunk.
    pub index: usize,
    pub id: Option<String>,
    pub name: Option<String>,
    pub arguments: Option<String>,
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
    /// The model's thinking, on the models that show it.
    ///
    /// DeepSeek's reasoner, and others, stream this separately from `content`.
    /// It used to be dropped here, which is why a model that spent two minutes
    /// thinking looked exactly like a model that had hung.
    ///
    /// Field name varies by vendor — `reasoning_content` (DeepSeek),
    /// `reasoning` (OpenAI-compatible gateways), `thinking` (Anthropic-shaped).
    /// All three are read, because a vendor switch must not silently turn the
    /// thinking display back into a blank wait.
    #[serde(default)]
    reasoning_content: Option<String>,
    #[serde(default)]
    reasoning: Option<String>,
    #[serde(default)]
    thinking: Option<String>,
    #[serde(default)]
    tool_calls: Option<Vec<RawToolCall>>,
}

#[derive(Deserialize)]
struct RawToolCall {
    #[serde(default)]
    index: Option<usize>,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    function: Option<RawFunctionCall>,
}

#[derive(Deserialize)]
struct RawFunctionCall {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    arguments: Option<String>,
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
                    // Whichever of the three field names the vendor used.
                    let thinking = d
                        .reasoning_content
                        .or(d.reasoning)
                        .or(d.thinking)
                        .filter(|t| !t.is_empty());
                    if let Some(t) = thinking {
                        c.reasoning = Some(match c.reasoning.take() {
                            Some(prev) => prev + &t,
                            None => t,
                        });
                    }
                    for (pos, raw) in d.tool_calls.unwrap_or_default().into_iter().enumerate() {
                        c.tool_calls.push(ToolCallDelta {
                            // Providers normally send `index`; a provider that
                            // omits it gets the position in this chunk, which is
                            // right for the single-call case everything here
                            // produces.
                            index: raw.index.unwrap_or(pos),
                            id: raw.id,
                            name: raw.function.as_ref().and_then(|f| f.name.clone()),
                            arguments: raw.function.as_ref().and_then(|f| f.arguments.clone()),
                        });
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

/// Accumulates streamed tool-call fragments into finished calls.
///
/// The protocol sends `id`, `name` and `arguments` as fragments, and
/// `arguments` in particular arrives as a series of string pieces that only
/// become valid JSON once joined. Keying by `index` rather than by `id` is
/// deliberate: `id` is itself a fragment on the first chunk, so it is missing
/// exactly when the call is first created.
#[derive(Debug, Default)]
pub struct ToolCallAccumulator {
    slots: Vec<Option<PendingCall>>,
}

#[derive(Debug, Default)]
struct PendingCall {
    id: String,
    name: String,
    arguments: String,
}

impl ToolCallAccumulator {
    pub fn new() -> Self {
        Self { slots: Vec::new() }
    }

    /// Feed one chunk's fragments. Order within a chunk is preserved.
    pub fn push(&mut self, deltas: &[ToolCallDelta]) {
        for d in deltas {
            while self.slots.len() <= d.index {
                self.slots.push(None);
            }
            let slot = self.slots[d.index].get_or_insert_with(PendingCall::default);
            if let Some(id) = &d.id {
                slot.id.push_str(id);
            }
            if let Some(name) = &d.name {
                slot.name.push_str(name);
            }
            if let Some(args) = &d.arguments {
                slot.arguments.push_str(args);
            }
        }
    }

    /// True when at least one call arrived.
    pub fn is_empty(&self) -> bool {
        self.slots.iter().all(|s| s.is_none())
    }

    /// Finish the calls. A call with no name is dropped: it cannot be executed
    /// and forwarding it would make the caller guess.
    pub fn finish(&self) -> Vec<super::types::ToolCall> {
        self.slots
            .iter()
            .flatten()
            .filter(|p| !p.name.trim().is_empty())
            .enumerate()
            .map(|(i, p)| super::types::ToolCall {
                // A provider that never sent an id gets a synthetic one. The
                // caller needs *something* to correlate its `tool` reply with.
                id: if p.id.trim().is_empty() {
                    format!("call_{i}")
                } else {
                    p.id.clone()
                },
                kind: "function".to_string(),
                function: super::types::FunctionCall {
                    name: p.name.clone(),
                    arguments: p.arguments.clone(),
                },
            })
            .collect()
    }
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

#[cfg(test)]
mod tool_call_tests {
    use super::*;

    fn delta(index: usize, id: Option<&str>, name: Option<&str>, args: Option<&str>) -> ToolCallDelta {
        ToolCallDelta {
            index,
            id: id.map(str::to_string),
            name: name.map(str::to_string),
            arguments: args.map(str::to_string),
        }
    }

    /// The protocol streams a call in pieces, and `arguments` is the piece that
    /// matters: it only becomes JSON once every fragment is joined, in order.
    #[test]
    fn fragments_are_joined_in_order() {
        let mut acc = ToolCallAccumulator::new();
        acc.push(&[delta(0, Some("call_a"), Some("read"), None)]);
        acc.push(&[delta(0, None, Some("_page"), None)]);
        acc.push(&[delta(0, None, None, Some("{\"pa"))]);
        acc.push(&[delta(0, None, None, Some("ge\": 5}"))]);

        let calls = acc.finish();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id, "call_a");
        assert_eq!(calls[0].function.name, "read_page", "name is streamed in pieces too");
        assert_eq!(calls[0].function.arguments, "{\"page\": 5}");
    }

    /// Index, not id, identifies a slot: the id arrives on the first fragment
    /// while the slot is being created, so keying on it would lose the call.
    #[test]
    fn slots_are_keyed_by_index_not_id() {
        let mut acc = ToolCallAccumulator::new();
        acc.push(&[delta(0, Some("a"), Some("read_page"), Some("{}"))]);
        acc.push(&[delta(1, Some("b"), Some("read_page"), Some("{}"))]);
        let calls = acc.finish();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].id, "a");
        assert_eq!(calls[1].id, "b");
    }

    /// Two fragments for the same slot arriving in one chunk must merge, not
    /// overwrite — the whole argument string can arrive split across one batch.
    #[test]
    fn several_fragments_in_one_chunk_merge() {
        let mut acc = ToolCallAccumulator::new();
        acc.push(&[
            delta(0, Some("c"), Some("read_page"), Some("{\"page\":")),
            delta(0, None, None, Some("7}")),
        ]);
        assert_eq!(acc.finish()[0].function.arguments, "{\"page\":7}");
    }

    #[test]
    fn nothing_arrives_means_no_calls() {
        let acc = ToolCallAccumulator::new();
        assert!(acc.is_empty());
        assert!(acc.finish().is_empty());
    }

    /// A nameless call cannot be executed. Dropping it is the only honest
    /// option: passing it on would make the caller guess what to run.
    #[test]
    fn a_call_without_a_name_is_dropped() {
        let mut acc = ToolCallAccumulator::new();
        acc.push(&[delta(0, Some("x"), None, Some("{}"))]);
        assert!(acc.finish().is_empty());
    }

    /// A provider that never sends an id still needs one, so the `tool` reply
    /// can be correlated with the call.
    #[test]
    fn a_missing_id_gets_a_synthetic_one() {
        let mut acc = ToolCallAccumulator::new();
        acc.push(&[delta(0, None, Some("read_page"), Some("{}"))]);
        let calls = acc.finish();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id, "call_0");
    }

    /// The parser must surface `delta.tool_calls` and leave ordinary content
    /// untouched — this is the same parser the plain-chat path uses.
    #[test]
    fn the_parser_reports_tool_call_deltas() {
        let mut p = SseParser::new();
        let evs = p.push(
            b"data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c1\",\
              \"function\":{\"name\":\"read_page\",\"arguments\":\"{\\\"page\\\":3}\"}}]}}]}\n\n",
        );
        let mut found = false;
        for e in evs {
            if let SseEvent::Chunk(c) = e {
                if !c.tool_calls.is_empty() {
                    found = true;
                    assert_eq!(c.tool_calls[0].index, 0);
                    assert_eq!(c.tool_calls[0].name.as_deref(), Some("read_page"));
                }
            }
        }
        assert!(found, "the parser dropped the tool_call delta");
    }

    /// Plain content must not grow a tool-call list it never had.
    #[test]
    fn ordinary_content_has_no_tool_calls() {
        let mut p = SseParser::new();
        let evs = p.push(b"data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n");
        for e in evs {
            if let SseEvent::Chunk(c) = e {
                assert!(c.tool_calls.is_empty());
                assert_eq!(c.content.as_deref(), Some("hi"));
            }
        }
    }
}
