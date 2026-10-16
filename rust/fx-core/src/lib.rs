//! # fx-core: the FX inference contract
//!
//! The provider-neutral contract shared by the FX executor, the Easy-LLM capability
//! adapter and the Node and WebAssembly adapters. This crate holds data types,
//! deterministic request validation and the versioned JSON encoding. It has no
//! executor yet, and by design it contains no provider SDK, HTTP client, network,
//! filesystem, process, environment or async-runtime access.
//!
//! Contract invariants established here (see `docs/rebuild/ARCHITECTURE.md`):
//!
//! 1. One contract version ([`CONTRACT_VERSION`]) and one typed semantic model
//!    ([`contract`]); JSON is boundary encoding only ([`wire`]).
//! 2. Invalid requests are rejected before any capability call
//!    ([`validate::validate_request`], [`wire::parse_request`]).
//! 3. Delivery certainty is monotonic ([`DeliveryCertainty::advance`]).
//! 4. Cancellation never implies the remote operation did not execute
//!    ([`DeliveryCertainty::may_have_executed`], [`Cancellation`]).
//! 5. Tool proposals are data ([`ToolCallProposal`]) with no execution authority.
//! 6. Provider-executed tool records ([`ProviderToolRecord`]) are a distinct type.
//! 7. Every input size and collection count is bounded by [`Limits`].
//! 8. Errors and diagnostic detail carry no prompts, image bytes, tool arguments,
//!    credentials or full provider bodies ([`Detail`], [`validate::ValidationError`],
//!    [`wire::DecodeError`]).
//! 9. No ambient network, filesystem, process, credential or configuration access.
//! 10. No host-specific type appears in the contract.

mod base64;
pub mod contract;
mod json_check;
mod redact;
pub mod validate;
pub mod wire;

pub use contract::*;
pub use validate::{
    Location, ValidationCode, ValidationError, validate_event_bounds, validate_request,
};
pub use wire::{
    DecodeError, DecodeErrorKind, RequestRejection, decode_capability_error, decode_event,
    decode_outcome, decode_request, encode_capability_error, encode_event, encode_outcome,
    encode_request, parse_request,
};
