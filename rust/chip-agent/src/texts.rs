//! Fixed texts and limits, copied from the Zig oracle so the model sees the same words.
//!
//! Each constant names its source in `src/` of the oracle.

/// Model-facing text when no assistant text was produced and the turn ends
/// (`core/agent/runtime/orchestrator.zig`, "Done.").
pub const DONE_TEXT: &str = "Done.";

/// Default operational notice when the step limit is reached
/// (`core/agent/runtime/config.zig:210`).
pub const STEP_LIMIT_NOTICE: &str =
    "Agent step limit reached; continue with a follow-up prompt if needed.";

/// Fixed text when automatic safety checks blocked four response groups in a row
/// (`core/agent/runtime/orchestrator.zig:2084-2126`).
pub const AUTOMATIC_BLOCKER_TEXT: &str = "I couldn't continue because the required actions were blocked by automatic safety checks. I need a different approach or explicit direction from you.";

/// Consecutive tool-response groups with automatic denials and no success that end the
/// turn (`max_automatic_denial_response_groups`, orchestrator.zig:2084).
pub const MAX_AUTOMATIC_DENIAL_GROUPS: u32 = 4;

/// Tool steps with no assistant text before the one-time summary prompt is injected
/// (orchestrator.zig:4242-4258).
pub const SILENT_STEPS_BEFORE_CONTINUATION: u32 = 2;

/// The user message injected by the silent-tool continuation.
pub const SILENT_CONTINUATION_PROMPT: &str = "Summarize what you just did.";

/// Default model-facing cap on one tool result
/// (`core/tooling/tool_result_limits.zig:7`).
pub const DEFAULT_TOOL_RESULT_CAP: usize = 64 * 1024;

/// Default turn-level attempt limit (`model_response_recovery.zig:3`).
pub const DEFAULT_MAX_PROVIDER_ATTEMPTS: u32 = 10;

/// Longest recovery delay (`model_response_recovery.zig`, 30 s cap).
pub const MAX_RECOVERY_DELAY_MS: u64 = 30_000;

/// Text of a tool result for a call that was closed because the turn was cancelled.
pub const CANCELLED_RESULT_TEXT: &str = "Cancelled";

/// Text of the synthetic result for an interrupted tool call on resume
/// (`core/session/session.zig:62`).
pub const ABORTED_TOOL_TEXT: &str = "aborted by user";

/// The user message that closes an interrupted turn when history is rebuilt
/// (`core/session/session.zig:49-53`).
pub const INTERRUPTED_TURN_CONTEXT: &str = "<turn_aborted>\nThe previous turn ended before completion. Any tools or commands may have partially executed. Do not continue this request unless the user explicitly asks to continue.\n</turn_aborted>";
