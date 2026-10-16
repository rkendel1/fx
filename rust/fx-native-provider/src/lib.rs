//! Native Rust providers behind the FX single-attempt [`ProviderPort`].
//!
//! This crate is a *host* adapter, like the Node bridge: it performs the one provider call
//! and reports observations. Validation, normalization, delivery certainty, cancellation and
//! terminal outcomes stay in `fx-core` and `fx-single-attempt`. It does not retry, fall back,
//! route between models, run tools, or loop. See `docs/rebuild/NATIVE_PROVIDER.md`.
//!
//! [`ProviderPort`]: fx_single_attempt::ProviderPort

mod body;
mod config;
mod provider;
mod secret;
mod sse;

pub use config::{ConfigError, OpenAiConfig};
pub use provider::{OpenAiCall, OpenAiCompatible};
pub use secret::Secret;
