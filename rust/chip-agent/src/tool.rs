//! Tools as Chip sees them: specifications, calls, results and the model-facing error
//! texts. A tool call is untrusted data proposed by a model; nothing here executes one.

use fx_core::{Detail, Limits, ToolDefinition, ToolExecution};
use serde_json::Value;

/// How a tool is gated when no rule decides it
/// (`ToolApprovalPolicy`, `core/tooling/tool_dispatch.zig`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum ApprovalPolicy {
    /// The normal path: approval depends on the mode and on `requires_approval`.
    #[default]
    Standard,
    /// The tool needs a human in `ask` mode and is allowed in `auto` (the oracle's `vision`).
    AskOnly,
}

/// A tool the agent may offer the model. Offering a tool grants no authority to run it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolSpec {
    /// Tool name; unique within an agent.
    pub name: String,
    /// Model-facing description.
    pub description: String,
    /// JSON Schema (an object) for the arguments, as JSON text.
    pub input_schema_json: String,
    /// The permission this tool is checked under. Defaults to the tool name; the oracle
    /// maps for example `read_file` to `read` and `write_file` to `edit`.
    pub permission: String,
    /// The argument that names the target (a path or command) matched by rules.
    pub target_field: Option<String>,
    /// Whether running the tool needs approval by default.
    pub requires_approval: bool,
    /// Whether `auto` mode may run the tool without review (a known reversible,
    /// non-sensitive action).
    pub reversible: bool,
    /// Gating policy.
    pub approval_policy: ApprovalPolicy,
}

impl ToolSpec {
    /// A read-only tool that needs no approval.
    pub fn read_only(name: &str, description: &str, input_schema_json: &str) -> ToolSpec {
        ToolSpec {
            name: name.to_owned(),
            description: description.to_owned(),
            input_schema_json: input_schema_json.to_owned(),
            permission: name.to_owned(),
            target_field: None,
            requires_approval: false,
            reversible: true,
            approval_policy: ApprovalPolicy::Standard,
        }
    }

    /// A tool that changes state and needs approval by default.
    pub fn effectful(name: &str, description: &str, input_schema_json: &str) -> ToolSpec {
        ToolSpec {
            requires_approval: true,
            reversible: false,
            ..ToolSpec::read_only(name, description, input_schema_json)
        }
    }

    /// The FX tool definition for this spec. Chip offers it; whether the provider path
    /// can carry it is FX's decision, and today it refuses (a visible failure, never a
    /// silent downgrade).
    pub fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: self.name.clone(),
            description: self.description.clone(),
            input_schema_json: self.input_schema_json.clone(),
            execution: ToolExecution::Client,
            provider_args_json: None,
        }
    }
}

/// Whether the arguments of a call were usable as the model produced them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ArgumentIntegrity {
    /// Valid JSON, as produced.
    Valid,
    /// Malformed or absent; FX replaced them with `{}`.
    Malformed,
}

/// A model-proposed tool call. Untrusted data.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolCall {
    /// Provider-assigned id.
    pub id: String,
    /// Proposed tool name.
    pub name: String,
    /// Proposed arguments as JSON text (`{}` when they were malformed).
    pub arguments_json: String,
    /// Whether the arguments were usable.
    pub integrity: ArgumentIntegrity,
}

/// The outcome of a tool call as the model sees it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolStatus {
    /// The tool ran and reported success.
    Success,
    /// The tool did not run or reported failure.
    Failure,
}

impl ToolStatus {
    /// The persisted label.
    pub fn as_str(self) -> &'static str {
        match self {
            ToolStatus::Success => "success",
            ToolStatus::Failure => "failure",
        }
    }
}

/// A finished tool call.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolResult {
    /// Id of the call.
    pub call_id: String,
    /// Name of the call.
    pub name: String,
    /// Status.
    pub status: ToolStatus,
    /// The model-facing text, capped.
    pub output: String,
    /// Size of the output before the cap.
    pub output_bytes: usize,
    /// Whether the cap cut the output.
    pub truncated: bool,
}

/// Why a tool did not run because of policy.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum DenialReason {
    /// A person said no.
    UserDenied,
    /// Auto mode's reviewer said no, or could not decide.
    AutoDenied,
    /// A configured rule said no.
    PolicyDenied,
    /// Approval is required and nobody can give it.
    PermissionRequired,
}

impl DenialReason {
    /// The wire label.
    pub fn as_str(self) -> &'static str {
        match self {
            DenialReason::UserDenied => "user_denied",
            DenialReason::AutoDenied => "auto_denied",
            DenialReason::PolicyDenied => "policy_denied",
            DenialReason::PermissionRequired => "permission_required",
        }
    }
}

fn json_string(text: &str) -> String {
    Value::String(text.to_owned()).to_string()
}

/// Masks secret-shaped tokens and bounds model-controlled text with FX's own rule.
fn masked(text: &str) -> String {
    Detail::new(text, &Limits::default()).as_str().to_owned()
}

/// `tool_execution_failed` JSON (`toolExecutionFailureJson`,
/// `core/tooling/tool_result_errors.zig:238`).
pub fn execution_failure_json(tool_name: &str, message: &str, suggestion: Option<&str>) -> String {
    let mut out = String::from("{\"error\":{\"type\":\"tool_execution_failed\",\"tool_name\":");
    out.push_str(&json_string(&masked(tool_name)));
    out.push_str(",\"message\":");
    out.push_str(&json_string(&masked(message)));
    if let Some(suggestion) = suggestion {
        out.push_str(",\"suggestion\":");
        out.push_str(&json_string(&masked(suggestion)));
    }
    out.push_str("}}");
    out
}

/// The text for arguments that were not valid JSON (`malformedToolArgumentsJson`,
/// `tool_result_errors.zig:324`).
pub fn malformed_arguments_json(tool_name: &str) -> String {
    execution_failure_json(
        tool_name,
        "Tool arguments were not valid JSON.",
        Some("Reissue the tool call with complete valid JSON arguments matching the tool schema."),
    )
}

/// `Unsupported tool: <name>` (`core/agent/runtime/orchestrator.zig:194-208`).
pub fn unsupported_tool_text(tool_name: &str) -> String {
    format!("Unsupported tool: {}", masked(tool_name))
}

fn is_network_tool(tool_name: &str) -> bool {
    tool_name == "web_search"
}

fn denied_message(tool_name: &str, reason: DenialReason) -> &'static str {
    match reason {
        DenialReason::UserDenied => "Permission denied by user",
        DenialReason::AutoDenied => "Permission denied by auto mode classifier",
        DenialReason::PolicyDenied if is_network_tool(tool_name) => {
            "Network or browser access was denied by configured policy"
        }
        DenialReason::PolicyDenied => "Tool access was denied by configured policy",
        DenialReason::PermissionRequired if tool_name == "run_command" || tool_name == "terminal" => {
            "Shell command approval is required before this tool can run"
        }
        DenialReason::PermissionRequired if is_network_tool(tool_name) => {
            "Network or browser approval is required before this tool can run"
        }
        DenialReason::PermissionRequired => "Tool approval is required before this tool can run",
    }
}

fn denied_suggestion(reason: DenialReason) -> &'static str {
    match reason {
        DenialReason::UserDenied => "The tool did not run. Do not retry unchanged; explain the denial or use a safer allowed alternative.",
        DenialReason::AutoDenied => "The tool did not run. Do not retry unchanged or ask the user for approval. Replan autonomously with a materially different safe action or an existing deterministic safe tool; fx will use its human approval channel after bounded recovery.",
        DenialReason::PolicyDenied => "The tool did not run. Do not retry unchanged; explain the configured policy blocker or use an allowed alternative.",
        DenialReason::PermissionRequired => "The tool did not run. Noninteractive mode cannot show an approval prompt. Rerun interactively to approve, or configure a narrow permission rule before retrying.",
    }
}

/// `tool_permission_denied` JSON (`toolPermissionDeniedJson`,
/// `tool_result_errors.zig:142`).
pub fn permission_denied_json(tool_name: &str, reason: DenialReason) -> String {
    let mut out = String::from("{\"error\":{\"type\":\"tool_permission_denied\",\"tool_name\":");
    out.push_str(&json_string(&masked(tool_name)));
    out.push_str(",\"message\":");
    out.push_str(&json_string(denied_message(tool_name, reason)));
    out.push_str(",\"reason\":");
    out.push_str(&json_string(reason.as_str()));
    out.push_str(",\"denied\":true,\"suggestion\":");
    out.push_str(&json_string(denied_suggestion(reason)));
    out.push_str("}}");
    out
}

/// Caps one tool result for the model: UTF-8 safe, with the oracle's marker
/// (`core/tooling/tool_result_limits.zig:33`). The marker counts against the cap.
pub fn cap_output(tool_name: &str, output: &str, cap: usize) -> (String, bool) {
    if output.len() <= cap {
        return (output.to_owned(), false);
    }
    let marker = format!(
        "\n... [tool result truncated for {}: original {} bytes; cap is {} bytes]\n",
        masked(tool_name),
        output.len(),
        cap
    );
    let keep = cap.saturating_sub(marker.len());
    let mut end = keep.min(output.len());
    while end > 0 && !output.is_char_boundary(end) {
        end -= 1;
    }
    let mut capped = output[..end].to_owned();
    capped.push_str(&marker);
    (capped, true)
}

/// Checks arguments against the tool's schema: a JSON object with every `required`
/// field present. The oracle validates per tool; this generic check is the part every
/// schema states. Returns the message for the model on failure.
pub fn validate_arguments(spec: &ToolSpec, arguments_json: &str) -> Result<(), String> {
    let value: Value = match serde_json::from_str(arguments_json) {
        Ok(value) => value,
        Err(_) => return Err("Tool arguments were not valid JSON.".to_owned()),
    };
    let Some(object) = value.as_object() else {
        return Err("Tool arguments must be a JSON object.".to_owned());
    };
    let schema: Value = serde_json::from_str(&spec.input_schema_json).unwrap_or(Value::Null);
    if let Some(required) = schema.get("required").and_then(Value::as_array) {
        for field in required.iter().filter_map(Value::as_str) {
            if !object.contains_key(field) {
                return Err(format!("Tool arguments are missing required field `{field}`."));
            }
        }
    }
    Ok(())
}

/// The string value of the argument that names the target, if the spec declares one.
pub fn target_of(spec: &ToolSpec, arguments_json: &str) -> Option<String> {
    let field = spec.target_field.as_deref()?;
    let value: Value = serde_json::from_str(arguments_json).ok()?;
    value.get(field)?.as_str().map(str::to_owned)
}
