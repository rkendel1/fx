//! Tool authorization. Chip decides whether a proposed call may run; the model's
//! proposal is untrusted data and grants nothing.
//!
//! The decision follows the oracle's order for ordinary tools
//! (`core/tooling/tool_admission.zig:1122-1340`, "Permission model" in
//! `docs/rebuild/CHIP_FX_RUNTIME.md`): `yolo` bypasses policy; a configured deny beats
//! everything; a saved-session deny narrows a configured allow; a saved-session allow
//! satisfies an unresolved ask; a configured ask needs a person unless a session grant
//! matches; a configured allow or a grant allows; then the mode's default decides.
//!
//! Not ported (listed as retirement blockers): live child-agent authority
//! revalidation, sandbox widening, command planning and the file-mutation preflight.

use crate::tool::{DenialReason, ToolCall, ToolSpec, target_of};

/// The baseline posture (`PermissionMode`, `core/shared/types.zig:1503`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum PermissionMode {
    /// Ask a person for anything that needs approval.
    #[default]
    Ask,
    /// Never ask a person; a reviewer allows or the call is denied.
    Auto,
    /// Bypass Chip's permission policy.
    Yolo,
}

/// What a configured rule says.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RuleDecision {
    /// Allow.
    Allow,
    /// Ask a person.
    Ask,
    /// Deny.
    Deny,
}

/// One configured rule. The last matching rule wins.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Rule {
    /// Permission name or tool name pattern (`*` matches any run of characters).
    pub permission: String,
    /// Target pattern; `None` matches every target.
    pub target: Option<String>,
    /// The decision.
    pub decision: RuleDecision,
}

/// A grant a person gave for the rest of the session.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Grant {
    /// Permission name.
    pub permission: String,
    /// Exact target.
    pub target: String,
}

/// A remembered decision for one exact call (`session_permission_state`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SavedDecision {
    /// Tool name.
    pub name: String,
    /// Exact arguments.
    pub arguments_json: String,
    /// Whether the remembered decision allows the call.
    pub allow: bool,
}

/// The inputs to every decision.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Policy {
    /// Baseline posture.
    pub mode: PermissionMode,
    /// Configured rules, in order.
    pub rules: Vec<Rule>,
    /// Session grants.
    pub grants: Vec<Grant>,
    /// Remembered exact decisions.
    pub saved: Vec<SavedDecision>,
}

/// What Chip decided before any person or reviewer is involved.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Decision {
    /// The call may run.
    Allow,
    /// The call must not run.
    Deny(DenialReason),
    /// A person must decide.
    NeedApproval,
    /// Auto mode's reviewer must decide.
    NeedReview,
}

/// Glob match where `*` matches any run of characters and everything else is literal.
pub fn wildcard_match(pattern: &str, text: &str) -> bool {
    let pattern: Vec<char> = pattern.chars().collect();
    let text: Vec<char> = text.chars().collect();
    let (mut p, mut t) = (0, 0);
    let (mut star, mut mark) = (None, 0);
    while t < text.len() {
        if p < pattern.len() && pattern[p] == '*' {
            star = Some(p);
            mark = t;
            p += 1;
        } else if p < pattern.len() && pattern[p] == text[t] {
            p += 1;
            t += 1;
        } else if let Some(s) = star {
            p = s + 1;
            mark += 1;
            t = mark;
        } else {
            return false;
        }
    }
    while p < pattern.len() && pattern[p] == '*' {
        p += 1;
    }
    p == pattern.len()
}

fn rule_decision(policy: &Policy, spec: &ToolSpec, target: &str) -> Option<RuleDecision> {
    policy
        .rules
        .iter()
        .rev()
        .find(|rule| {
            (wildcard_match(&rule.permission, &spec.permission) || wildcard_match(&rule.permission, &spec.name))
                && rule.target.as_deref().is_none_or(|pattern| wildcard_match(pattern, target))
        })
        .map(|rule| rule.decision)
}

fn grant_matches(policy: &Policy, spec: &ToolSpec, target: &str) -> bool {
    policy
        .grants
        .iter()
        .any(|grant| grant.permission == spec.permission && grant.target == target)
}

/// Decides one call. Pure: it reads the policy and the call and nothing else.
pub fn decide(policy: &Policy, spec: &ToolSpec, call: &ToolCall) -> Decision {
    if policy.mode == PermissionMode::Yolo {
        return Decision::Allow;
    }
    let target = target_of(spec, &call.arguments_json).unwrap_or_else(|| "*".to_owned());
    let by_rule = rule_decision(policy, spec, &target);
    if by_rule == Some(RuleDecision::Deny) {
        return Decision::Deny(DenialReason::PolicyDenied);
    }
    let saved = policy
        .saved
        .iter()
        .find(|saved| saved.name == call.name && saved.arguments_json == call.arguments_json);
    if let Some(saved) = saved {
        return if saved.allow {
            Decision::Allow
        } else {
            Decision::Deny(DenialReason::PolicyDenied)
        };
    }
    let granted = grant_matches(policy, spec, &target);
    match by_rule {
        Some(RuleDecision::Ask) if !granted => return Decision::NeedApproval,
        Some(RuleDecision::Allow) => return Decision::Allow,
        _ => {}
    }
    if granted {
        return Decision::Allow;
    }
    if spec.approval_policy == crate::tool::ApprovalPolicy::AskOnly {
        return if policy.mode == PermissionMode::Auto {
            Decision::Allow
        } else {
            Decision::NeedApproval
        };
    }
    if !spec.requires_approval {
        return Decision::Allow;
    }
    match policy.mode {
        PermissionMode::Auto if spec.reversible => Decision::Allow,
        PermissionMode::Auto => Decision::NeedReview,
        _ => Decision::NeedApproval,
    }
}

/// What a person answered to an approval request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ApprovalVerdict {
    /// Allow this call.
    Once,
    /// Allow this call and remember a grant for the rest of the session.
    Always,
    /// Deny; the feedback, if any, is shown to the model after the tool results.
    Deny {
        /// A person's explanation.
        feedback: Option<String>,
    },
    /// Nobody can be asked (noninteractive).
    Unavailable,
}

/// What auto mode's reviewer answered.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReviewVerdict {
    /// Allow this one call.
    Allow,
    /// The reviewer would ask a person. Auto mode never prompts one, so this is a denial.
    Ask,
    /// The reviewer's answer was unusable.
    Invalid,
    /// There is no reviewer.
    Unavailable,
}
