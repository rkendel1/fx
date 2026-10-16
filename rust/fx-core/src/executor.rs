//! The one-attempt FX inference executor.
//!
//! [`execute`] validates a request, starts the supplied capability at most once,
//! drives it in bounded batches, normalizes every event, forwards normalized events
//! to the host, and returns exactly one terminal [`Outcome`] with content-free
//! [`Diagnostics`].
//!
//! It never retries, falls back, selects models, refreshes credentials, reconnects,
//! plans, executes tools or recovers across turns. Those belong to Easy-LLM (inside
//! the capability) and Chip (around the executor).
//!
//! ## Cancellation and budget (what is and is not guaranteed)
//!
//! The core has no clock, thread or async runtime. Therefore:
//!
//! - The executor checks [`Host::cancel_requested`] before starting the capability and
//!   between polls, and treats an observer that returns [`Flow::Stop`] as abandonment.
//!   It cannot interrupt a capability call that is in progress: a `poll` that blocks
//!   delays cancellation until it returns. The capability contract requires `poll`
//!   and `cancel` not to block indefinitely.
//! - The attempt budget is passed to the capability ([`AttemptContext::budget`]),
//!   which owns the clock and must report [`ErrorKind::Timeout`]. A host may also
//!   enforce a deadline by returning `true` from `cancel_requested` or
//!   [`Flow::Stop`] from [`Host::idle`].
//! - Cancellation is always reported with the delivery certainty observed so far.
//!   A cancelled outcome never claims the remote operation did not execute unless
//!   delivery is still `DefinitelyUnsent` (invariant 4).

use crate::capability::{AttemptContext, CancelStatus, Capability, Started, StreamState};
use crate::contract::{
    Cancellation, CapabilityError, DeliveryCertainty, ErrorKind, Event, Failure, FailureOrigin,
    Limits, Outcome, RemoteCancellation, Request,
};
use crate::diagnostics::{Diagnostics, TerminalCause};
use crate::normalize::{Disposition, Normalizer, ProposalCheck, Pushed, classify};
use crate::validate::validate_request;
use crate::wire::{RequestRejection, parse_request};

/// Whether the host wants the attempt to continue.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Flow {
    /// Keep going.
    Continue,
    /// Stop: the executor cancels the capability and returns `Cancelled`.
    Stop,
}

/// The executor's view of its host: cancellation, event delivery and idling.
///
/// All methods have defaults, so a host implements only what it needs.
pub trait Host {
    /// Polled before start and between polls. Return `true` to cancel.
    fn cancel_requested(&mut self) -> bool {
        false
    }

    /// Receives each normalized event in order, before the terminal outcome.
    /// Return [`Flow::Stop`] to abandon the attempt.
    fn on_event(&mut self, _event: &Event) -> Flow {
        Flow::Continue
    }

    /// Called when a poll returned no events and the stream is still open. A host
    /// may wait here (sleep, yield, block on a channel). Return [`Flow::Stop`] to
    /// cancel, for example when its own deadline passed.
    fn idle(&mut self) -> Flow {
        Flow::Continue
    }
}

/// A host that never cancels and ignores events.
#[derive(Clone, Copy, Debug, Default)]
pub struct NoHost;

impl Host for NoHost {}

/// Everything an attempt produced.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExecutionReport {
    /// Exactly one terminal outcome.
    pub outcome: Outcome,
    /// Per-proposal identity and argument checks, index-aligned with
    /// `Completion.proposals` (empty unless completed).
    pub proposal_checks: Vec<ProposalCheck>,
    /// Classification of a completed outcome.
    pub disposition: Option<Disposition>,
    /// Content-free diagnostics.
    pub diagnostics: Diagnostics,
}

fn executor_failure(
    kind: ErrorKind,
    delivery: DeliveryCertainty,
    partial: Option<crate::contract::PartialOutput>,
) -> Outcome {
    Outcome::Failed(Failure {
        origin: FailureOrigin::Executor,
        kind,
        delivery,
        retry_after: None,
        status_hint: None,
        detail: None,
        partial,
    })
}

fn capability_failure(
    error: CapabilityError,
    delivery: DeliveryCertainty,
    partial: Option<crate::contract::PartialOutput>,
) -> Outcome {
    Outcome::Failed(Failure {
        origin: FailureOrigin::Capability,
        kind: error.kind,
        delivery,
        retry_after: error.retry_after,
        status_hint: error.status_hint,
        detail: error.detail,
        partial,
    })
}

/// Decodes, validates and executes a request document. Decode and validation
/// failures become `Failed { origin: Executor, kind: InvalidRequest }` without
/// invoking the capability.
pub fn execute_document<C: Capability, H: Host>(
    capability: &mut C,
    request_bytes: &[u8],
    limits: &Limits,
    host: &mut H,
) -> ExecutionReport {
    match parse_request(request_bytes, limits) {
        Ok(request) => execute(capability, &request, limits, host),
        Err(rejection) => {
            let mut diagnostics = Diagnostics::new(None);
            diagnostics.terminal = match rejection {
                RequestRejection::Invalid(e) => TerminalCause::InvalidRequest(e.code),
                RequestRejection::Decode(_) => {
                    TerminalCause::InvalidRequest(crate::validate::ValidationCode::Undecodable)
                }
            };
            ExecutionReport {
                outcome: executor_failure(
                    ErrorKind::InvalidRequest,
                    DeliveryCertainty::DefinitelyUnsent,
                    None,
                ),
                proposal_checks: Vec::new(),
                disposition: None,
                diagnostics,
            }
        }
    }
}

/// Executes one attempt. See the module documentation for guarantees.
pub fn execute<C: Capability, H: Host>(
    capability: &mut C,
    request: &Request,
    limits: &Limits,
    host: &mut H,
) -> ExecutionReport {
    let mut diagnostics = Diagnostics::new(Some(request));

    // 1. Validate before anything else; an invalid request never reaches the capability.
    if let Err(error) = validate_request(request, limits) {
        diagnostics.terminal = TerminalCause::InvalidRequest(error.code);
        return ExecutionReport {
            outcome: executor_failure(
                ErrorKind::InvalidRequest,
                DeliveryCertainty::DefinitelyUnsent,
                None,
            ),
            proposal_checks: Vec::new(),
            disposition: None,
            diagnostics,
        };
    }

    // 2. Cancellation before start: nothing was sent.
    if host.cancel_requested() {
        diagnostics.terminal = TerminalCause::CancelledBeforeStart;
        return ExecutionReport {
            outcome: Outcome::Cancelled(Cancellation {
                delivery: DeliveryCertainty::DefinitelyUnsent,
                remote: RemoteCancellation::NotStarted,
                partial: None,
            }),
            proposal_checks: Vec::new(),
            disposition: None,
            diagnostics,
        };
    }

    let mut normalizer = Normalizer::new(request, limits);
    let context = AttemptContext {
        request,
        limits,
        budget: request.budget,
    };

    // 3. Exactly one start.
    diagnostics.starts = 1;
    let Started {
        mut handle,
        delivery,
    } = match capability.start(&context) {
        Ok(started) => started,
        Err(error) => {
            let delivery = DeliveryCertainty::DefinitelyUnsent.advance(error.delivery);
            diagnostics.terminal = TerminalCause::StartFailed;
            diagnostics.delivery = delivery;
            return ExecutionReport {
                outcome: capability_failure(error, delivery, None),
                proposal_checks: Vec::new(),
                disposition: None,
                diagnostics,
            };
        }
    };
    normalizer.observe_delivery(delivery);

    // 4. Drive the stream.
    // A short-lived local enum; boxing the outcome would only add an allocation.
    #[allow(clippy::large_enum_variant)]
    enum Stop {
        Finished,
        Fail(Outcome, TerminalCause),
        Cancel(TerminalCause),
    }
    let mut cancel_remote = false;
    let stop = 'drive: loop {
        if host.cancel_requested() {
            break 'drive Stop::Cancel(TerminalCause::Cancelled);
        }
        if diagnostics.polls >= limits.max_polls_per_attempt as u64 {
            cancel_remote = true;
            break 'drive Stop::Fail(
                executor_failure(
                    ErrorKind::ResourceLimit,
                    normalizer.delivery(),
                    normalizer.partial(),
                ),
                TerminalCause::TooManyPolls,
            );
        }
        diagnostics.polls += 1;
        let batch = match capability.poll(&mut handle, limits.max_events_per_poll) {
            Ok(batch) => batch,
            Err(error) => {
                normalizer.observe_delivery(error.delivery);
                break 'drive Stop::Fail(
                    capability_failure(error, normalizer.delivery(), normalizer.partial()),
                    TerminalCause::PollFailed,
                );
            }
        };
        normalizer.observe_delivery(batch.delivery);
        if batch.events.len() > limits.max_events_per_poll {
            cancel_remote = true;
            break 'drive Stop::Fail(
                executor_failure(
                    ErrorKind::ProtocolViolation,
                    normalizer.delivery(),
                    normalizer.partial(),
                ),
                TerminalCause::BatchTooLarge,
            );
        }
        let had_events = !batch.events.is_empty();
        for event in batch.events {
            if normalizer.is_finished() {
                normalizer.note_late_event();
                continue;
            }
            match normalizer.push(event) {
                Ok(Pushed::Dropped) => {}
                Ok(Pushed::Forward(event)) => {
                    diagnostics.forwarded += 1;
                    if host.on_event(&event) == Flow::Stop {
                        break 'drive Stop::Cancel(TerminalCause::Abandoned);
                    }
                }
                Ok(Pushed::Finished(event)) => {
                    diagnostics.forwarded += 1;
                    // The outcome is decided by the finish; an observer stopping now
                    // cannot change it.
                    let _ = host.on_event(&event);
                }
                Err(violation) => {
                    cancel_remote = true;
                    break 'drive Stop::Fail(
                        executor_failure(
                            violation.kind(),
                            normalizer.delivery(),
                            normalizer.partial(),
                        ),
                        TerminalCause::Violation(violation),
                    );
                }
            }
        }
        if normalizer.is_finished() {
            break 'drive Stop::Finished;
        }
        if batch.state == StreamState::Ended {
            // Interrupted: the stream ended without a finish (oracle: eof/done without finish).
            break 'drive Stop::Fail(
                executor_failure(
                    ErrorKind::Transport,
                    normalizer.delivery(),
                    normalizer.partial(),
                ),
                TerminalCause::EndedWithoutFinish,
            );
        }
        if !had_events && host.idle() == Flow::Stop {
            break 'drive Stop::Cancel(TerminalCause::Cancelled);
        }
    };

    // 5. Exactly one terminal outcome; close exactly once.
    let (outcome, terminal) = match stop {
        Stop::Finished => match normalizer.completion() {
            Some(completion) => (Outcome::Completed(completion), TerminalCause::Finished),
            // Unreachable: `Finished` is produced only after a finish was accepted.
            // Fail closed rather than panic if that ever changes.
            None => (
                executor_failure(
                    ErrorKind::Internal,
                    normalizer.delivery(),
                    normalizer.partial(),
                ),
                TerminalCause::EndedWithoutFinish,
            ),
        },
        Stop::Fail(outcome, cause) => {
            if cancel_remote {
                diagnostics.cancels = 1;
                let _ = capability.cancel(&mut handle);
            }
            (outcome, cause)
        }
        Stop::Cancel(cause) => {
            diagnostics.cancels = 1;
            let remote = match capability.cancel(&mut handle) {
                CancelStatus::Requested => RemoteCancellation::Unconfirmed,
                CancelStatus::Confirmed => RemoteCancellation::Confirmed,
            };
            (
                Outcome::Cancelled(Cancellation {
                    delivery: normalizer.delivery(),
                    remote,
                    partial: normalizer.partial(),
                }),
                cause,
            )
        }
    };
    capability.close(handle);
    diagnostics.closes = 1;

    let (text, reasoning, tool_input) = normalizer.byte_counts();
    diagnostics.terminal = terminal;
    diagnostics.delivery = normalizer.delivery();
    diagnostics.events = normalizer.event_count() as u64;
    diagnostics.anomalies = normalizer.anomalies();
    diagnostics.text_bytes = text;
    diagnostics.reasoning_bytes = reasoning;
    diagnostics.tool_input_bytes = tool_input;

    let (proposal_checks, disposition) = match &outcome {
        Outcome::Completed(completion) => {
            (normalizer.checks().to_vec(), Some(classify(completion)))
        }
        _ => (Vec::new(), None),
    };
    ExecutionReport {
        outcome,
        proposal_checks,
        disposition,
        diagnostics,
    }
}
