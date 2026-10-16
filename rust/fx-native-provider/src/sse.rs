//! Incremental server-sent-events framing and OpenAI chunk decoding.
//!
//! Strict on purpose: invalid UTF-8, invalid JSON and unexpected shapes are reported, never
//! skipped, so a damaged stream cannot look like a clean one.

use fx_single_attempt::PortUsage;
use serde_json::Value;

/// One framed event.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Frame {
    /// The `data:` payload.
    Data(String),
}

/// Splits a byte stream into events.
#[derive(Default)]
pub(crate) struct Framer {
    buffer: Vec<u8>,
    data: Vec<String>,
}

impl Framer {
    /// Adds bytes and returns the events they completed.
    pub(crate) fn push(&mut self, bytes: &[u8]) -> Result<Vec<Frame>, String> {
        self.buffer.extend_from_slice(bytes);
        let mut out = Vec::new();
        while let Some(end) = self.buffer.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.buffer.drain(..=end).collect();
            let line = std::str::from_utf8(&line[..line.len() - 1])
                .map_err(|_| "the stream is not valid UTF-8".to_owned())?;
            let line = line.strip_suffix('\r').unwrap_or(line);
            if line.is_empty() {
                if !self.data.is_empty() {
                    out.push(Frame::Data(self.data.join("\n")));
                    self.data.clear();
                }
            } else if let Some(value) = line.strip_prefix("data:") {
                self.data
                    .push(value.strip_prefix(' ').unwrap_or(value).to_owned());
            }
            // Comments, `event:`, `id:` and `retry:` carry nothing this adapter uses.
        }
        Ok(out)
    }
}

/// What one decoded chunk carried.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Chunk {
    pub(crate) text: String,
    pub(crate) refusal: String,
    pub(crate) finish_reason: Option<String>,
    pub(crate) model: Option<String>,
    pub(crate) usage: Option<PortUsage>,
}

/// An in-stream provider error object.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Decoded {
    Chunk(Chunk),
    ProviderError(String),
}

pub(crate) fn decode(data: &str) -> Result<Decoded, String> {
    let value: Value =
        serde_json::from_str(data).map_err(|_| "a stream chunk is not valid JSON".to_owned())?;
    let object = value.as_object().ok_or("a stream chunk is not an object")?;
    if let Some(error) = object.get("error") {
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("the provider reported an error");
        return Ok(Decoded::ProviderError(message.to_owned()));
    }
    let mut chunk = Chunk {
        model: object
            .get("model")
            .and_then(Value::as_str)
            .map(str::to_owned),
        ..Chunk::default()
    };
    if let Some(choices) = object.get("choices") {
        let choices = choices.as_array().ok_or("`choices` is not an array")?;
        // One choice is requested. Another index is ignored, never merged.
        if let Some(choice) = choices
            .iter()
            .find(|c| c.get("index").and_then(Value::as_u64).unwrap_or(0) == 0)
        {
            if let Some(delta) = choice.get("delta") {
                if delta.get("tool_calls").is_some_and(|v| !v.is_null())
                    || delta.get("function_call").is_some_and(|v| !v.is_null())
                {
                    return Err("the provider proposed a tool call that was not offered".into());
                }
                if let Some(text) = delta.get("content").and_then(Value::as_str) {
                    chunk.text = text.to_owned();
                }
                if let Some(text) = delta.get("refusal").and_then(Value::as_str) {
                    chunk.refusal = text.to_owned();
                }
            }
            chunk.finish_reason = choice
                .get("finish_reason")
                .and_then(Value::as_str)
                .map(str::to_owned);
        }
    }
    if let Some(usage) = object.get("usage").filter(|u| u.is_object()) {
        let count = |v: Option<&Value>| v.and_then(Value::as_u64);
        chunk.usage = Some(PortUsage {
            input_tokens: count(usage.get("prompt_tokens")),
            output_tokens: count(usage.get("completion_tokens")),
            cache_read_tokens: count(usage.pointer("/prompt_tokens_details/cached_tokens")),
            reasoning_tokens: count(usage.pointer("/completion_tokens_details/reasoning_tokens")),
        });
    }
    Ok(Decoded::Chunk(chunk))
}
