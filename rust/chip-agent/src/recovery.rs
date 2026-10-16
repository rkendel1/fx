//! Turn-level recovery: what Chip does after an FX attempt failed.
//!
//! This is the port of `model_response_recovery.decide`
//! (`core/agent/runtime/model_response_recovery.zig:108-161`) with ONE intentional
//! difference, recorded as D1 in `docs/rebuild/CHIP_FX_RUNTIME.md`:
//!
//! > The oracle re-issues the provider request after an outcome whose delivery is
//! > `possibly_sent` (a network drop with no output, a 429, a 5xx, a missing finish).
//! > Chip never starts a new FX attempt merely because delivery is ambiguous. It starts
//! > one automatically only when FX proves the previous request was `DefinitelyUnsent`.
//! > Every other transient failure PAUSES the turn with the evidence, and a caller may
//! > resume it explicitly ([`crate::Input::Resume`]).
//!
//! Retrying an agent turn (a person or caller choosing to continue) is a different act
//! from repeating a provider request after ambiguity; this module keeps them apart.

use std::time::Duration;

use fx_core::{DeliveryCertainty, ErrorKind};

use crate::texts::MAX_RECOVERY_DELAY_MS;

/// Why the attempt failed, in the oracle's vocabulary (`FailureCause`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Cause {
    /// The connection dropped before any usable response.
    NetworkInterrupted,
    /// A response started and then stopped without a verified finish.
    ResponseInterrupted,
    /// The provider answered with a 5xx-class failure or an in-band provider error.
    ProviderUnavailable,
    /// The provider rate limited the request.
    RateLimited,
    /// The host suspended and resumed during the attempt.
    SystemResumed,
    /// The provider filtered the content.
    ContentFilter,
}

impl Cause {
    /// The persisted label.
    pub fn as_str(self) -> &'static str {
        match self {
            Cause::NetworkInterrupted => "network_interrupted",
            Cause::ResponseInterrupted => "response_interrupted",
            Cause::ProviderUnavailable => "provider_unavailable",
            Cause::RateLimited => "rate_limited",
            Cause::SystemResumed => "system_resumed",
            Cause::ContentFilter => "content_filter",
        }
    }

    /// Classifies an FX failure into a recoverable cause, or `None` when retrying cannot
    /// help (a validation, authentication, authorization, model, protocol or resource
    /// failure). `has_output` says whether the attempt produced text before failing.
    pub fn from_failure(kind: ErrorKind, has_output: bool) -> Option<Cause> {
        match kind {
            ErrorKind::RateLimited => Some(Cause::RateLimited),
            ErrorKind::ProviderUnavailable => Some(Cause::ProviderUnavailable),
            ErrorKind::SystemResumed => Some(Cause::SystemResumed),
            ErrorKind::Transport | ErrorKind::Timeout if has_output => Some(Cause::ResponseInterrupted),
            ErrorKind::Transport | ErrorKind::Timeout => Some(Cause::NetworkInterrupted),
            _ => None,
        }
    }
}

/// What a person or caller must do next (`RequiredAction`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RequiredAction {
    /// Resume later; nothing is wrong with the request.
    ContinueLater,
    /// The request must change before it can succeed.
    ChangeRequest,
}

impl RequiredAction {
    /// The persisted label.
    pub fn as_str(self) -> &'static str {
        match self {
            RequiredAction::ContinueLater => "continue_later",
            RequiredAction::ChangeRequest => "change_request",
        }
    }
}

/// The evidence a decision uses.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Evidence {
    /// The cause.
    pub cause: Cause,
    /// Delivery as FX reported it. Never inferred.
    pub delivery: DeliveryCertainty,
    /// Attempts already consumed in this turn.
    pub consumed: u32,
    /// Attempts allowed in this turn.
    pub limit: u32,
    /// The provider's requested wait, if any.
    pub retry_after: Option<Duration>,
    /// Whether the caller asked to cancel.
    pub cancelled: bool,
    /// How many times in a row this cause has occurred, including this one (pacing).
    pub pacing_attempt: u32,
}

/// What to do next.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    /// End the turn as failed.
    Stop(RequiredAction),
    /// End the turn as paused; a caller may resume it.
    Pause(RequiredAction),
    /// Wait this long, then start a new FX attempt.
    Retry {
        /// Delay before the new attempt.
        delay_ms: u64,
    },
}

/// The delay before attempt `n` of the same cause (1-based): 250 ms, 1 s, then doubling to
/// 30 s (`model_response_recovery.zig:51-67`). A provider-requested wait replaces it, capped.
pub fn delay_ms(pacing_attempt: u32, retry_after: Option<Duration>) -> u64 {
    if let Some(wait) = retry_after {
        return u64::try_from(wait.as_millis()).unwrap_or(u64::MAX).min(MAX_RECOVERY_DELAY_MS);
    }
    match pacing_attempt {
        0 | 1 => 250,
        2 => 1_000,
        n => 1_000u64
            .saturating_mul(1u64 << (n - 2).min(20))
            .min(MAX_RECOVERY_DELAY_MS),
    }
}

/// The recovery decision.
///
/// 1. A cancel stops. 2. A content filter stops and needs a changed request.
/// 3. An exhausted attempt budget pauses. 4. Only an attempt FX proved `DefinitelyUnsent`
/// is retried automatically (D1). 5. Anything else pauses with the evidence.
pub fn decide(evidence: &Evidence) -> Decision {
    if evidence.cancelled {
        return Decision::Stop(RequiredAction::ContinueLater);
    }
    if evidence.cause == Cause::ContentFilter {
        return Decision::Stop(RequiredAction::ChangeRequest);
    }
    if evidence.consumed >= evidence.limit {
        return Decision::Pause(RequiredAction::ContinueLater);
    }
    if evidence.delivery == DeliveryCertainty::DefinitelyUnsent {
        return Decision::Retry {
            delay_ms: delay_ms(evidence.pacing_attempt, evidence.retry_after),
        };
    }
    Decision::Pause(RequiredAction::ContinueLater)
}
