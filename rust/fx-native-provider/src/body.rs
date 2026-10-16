//! Translating an FX [`Request`] into a chat-completions body.
//!
//! Only text conversations are translated. Everything else is refused here, as a second line
//! behind `PortSupport` (which already keeps images, tools and options out), so an
//! unsupported shape can never be dispatched in a weakened form.

use fx_core::{Part, Request, Role, ToolChoice};
use serde_json::json;

/// Builds the request body, or names the first thing that cannot be carried.
pub(crate) fn build(request: &Request) -> Result<Vec<u8>, String> {
    if request.model.as_str().trim().is_empty() {
        return Err("the model reference is empty".into());
    }
    if !request.tools.is_empty() || !matches!(request.tool_choice, ToolChoice::Auto) {
        return Err("tools are not supported by the native provider".into());
    }
    let mut messages = Vec::with_capacity(request.messages.len());
    for message in &request.messages {
        let role = match message.role {
            Role::System => "system",
            Role::User => "user",
            Role::Assistant => "assistant",
            Role::Tool => return Err("tool messages are not supported".into()),
        };
        let mut text = String::new();
        for part in &message.parts {
            match part {
                Part::Text(t) => text.push_str(t),
                _ => return Err("only text parts are supported".into()),
            }
        }
        messages.push(json!({"role": role, "content": text}));
    }
    let body = json!({
        "model": request.model.as_str(),
        "messages": messages,
        "stream": true,
        "stream_options": {"include_usage": true},
    });
    serde_json::to_vec(&body).map_err(|e| e.to_string())
}
