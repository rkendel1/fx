//! The OpenAI-compatible chat-completions wire format (streaming).
//!
//! Serves OpenAI, OpenRouter, LM Studio and other servers that speak this format.

use fx_core::{Part, ReasoningEffort, Request, Role, Speed, ToolChoice};
use fx_single_attempt::{PortItem, PortSupport, PortUsage, Terminal};
use serde_json::{Value, json};

use crate::config::{Common, OpenAiConfig};
use crate::secret::Secret;
use crate::wire::{Decoder, Step, Wire};

pub struct OpenAiWire {
    pub(crate) config: OpenAiConfig,
}

/// Options this wire format carries: only an output token cap. Anything else FX could ask
/// for is refused here, before any thread starts.
pub(crate) fn check_options(request: &Request) -> Result<(), String> {
    if request.options.reasoning != ReasoningEffort::Default {
        return Err("reasoning effort is not supported by the native provider".into());
    }
    if request.options.speed != Speed::Standard {
        return Err("speed is not supported by the native provider".into());
    }
    if request.options.response_format.is_some() {
        return Err("structured output is not supported by the native provider".into());
    }
    Ok(())
}

/// Text of a message, or the first thing in it that cannot be carried.
pub(crate) fn plain_text(parts: &[Part]) -> Result<String, String> {
    let mut text = String::new();
    for part in parts {
        match part {
            Part::Text(t) => text.push_str(t),
            _ => return Err("only text parts are supported".into()),
        }
    }
    Ok(text)
}

pub(crate) fn check_common(request: &Request) -> Result<(), String> {
    if request.model.as_str().trim().is_empty() {
        return Err("the model reference is empty".into());
    }
    if !request.tools.is_empty() || !matches!(request.tool_choice, ToolChoice::Auto) {
        return Err("tools are not supported by the native provider".into());
    }
    check_options(request)
}

impl Wire for OpenAiWire {
    fn support(&self) -> PortSupport {
        PortSupport {
            generation_options: true,
            ..PortSupport::default()
        }
    }

    fn url(&self) -> String {
        self.config.common.endpoint("chat/completions")
    }

    fn headers(&self) -> Vec<(String, String)> {
        let mut headers = vec![
            ("accept".to_owned(), "text/event-stream".to_owned()),
            ("content-type".to_owned(), "application/json".to_owned()),
        ];
        if let Some(key) = &self.config.common.key {
            headers.push((
                "authorization".to_owned(),
                format!("Bearer {}", key.expose()),
            ));
        }
        headers.extend(self.config.common.extra_headers.iter().cloned());
        headers
    }

    fn body(&self, request: &Request) -> Result<Vec<u8>, String> {
        check_common(request)?;
        let mut messages = Vec::with_capacity(request.messages.len());
        for message in &request.messages {
            let role = match message.role {
                Role::System => "system",
                Role::User => "user",
                Role::Assistant => "assistant",
                Role::Tool => return Err("tool messages are not supported".into()),
            };
            messages.push(json!({"role": role, "content": plain_text(&message.parts)?}));
        }
        let mut body = json!({
            "model": request.model.as_str(),
            "messages": messages,
            "stream": true,
            "stream_options": {"include_usage": true},
        });
        if let Some(max) = request.options.max_output_tokens {
            body["max_tokens"] = json!(max);
        }
        serde_json::to_vec(&body).map_err(|e| e.to_string())
    }

    fn decoder(&self) -> Box<dyn Decoder> {
        Box::new(OpenAiDecoder::default())
    }

    fn secret(&self) -> Option<&Secret> {
        self.config.common.key.as_ref()
    }

    fn settings(&self) -> &Common {
        &self.config.common
    }
}

#[derive(Default)]
struct OpenAiDecoder {
    finish: Option<String>,
    model: Option<String>,
    usage: Option<PortUsage>,
    refused: bool,
}

impl Decoder for OpenAiDecoder {
    fn feed(&mut self, _event: Option<&str>, data: &str) -> Result<Step, String> {
        if data.trim() == "[DONE]" {
            if self.finish.is_none() {
                return Err("the stream ended without a finish reason".into());
            }
            return Ok(Step::Done(PortItem::Done {
                usage: self.usage.take(),
                finish_reason: if self.refused {
                    Some("content_filter".to_owned())
                } else {
                    self.finish.take()
                },
                model: self.model.take(),
                terminal: Terminal::ProviderMarker,
            }));
        }
        let value: Value = serde_json::from_str(data)
            .map_err(|_| "a stream chunk is not valid JSON".to_owned())?;
        let object = value.as_object().ok_or("a stream chunk is not an object")?;
        if let Some(error) = object.get("error") {
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("the provider reported an error");
            return Ok(Step::ProviderError(message.to_owned()));
        }
        if let Some(model) = object.get("model").and_then(Value::as_str) {
            self.model = Some(model.to_owned());
        }
        let mut items = Vec::new();
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
                    if let Some(text) = delta.get("content").and_then(Value::as_str)
                        && !text.is_empty()
                    {
                        items.push(PortItem::Text(text.to_owned()));
                    }
                    if let Some(text) = delta.get("refusal").and_then(Value::as_str)
                        && !text.is_empty()
                    {
                        self.refused = true;
                        items.push(PortItem::Text(text.to_owned()));
                    }
                }
                if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
                    self.finish = Some(reason.to_owned());
                }
            }
        }
        if let Some(usage) = object.get("usage").filter(|u| u.is_object()) {
            let count = |v: Option<&Value>| v.and_then(Value::as_u64);
            self.usage = Some(PortUsage {
                input_tokens: count(usage.get("prompt_tokens")),
                output_tokens: count(usage.get("completion_tokens")),
                cache_read_tokens: count(usage.pointer("/prompt_tokens_details/cached_tokens")),
                reasoning_tokens: count(
                    usage.pointer("/completion_tokens_details/reasoning_tokens"),
                ),
            });
        }
        Ok(Step::Items(items))
    }
}
