//! Host-provided configuration. Nothing here is read from the environment.

use std::time::Duration;

use crate::secret::Secret;

/// Why a configuration was refused.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfigError(pub String);

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ConfigError {}

/// Settings for one OpenAI-compatible endpoint.
#[derive(Clone, Debug)]
pub struct OpenAiConfig {
    base_url: String,
    pub(crate) api_key: Secret,
    pub(crate) connect_timeout: Duration,
    pub(crate) default_deadline: Duration,
}

impl OpenAiConfig {
    /// Default connect timeout.
    pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
    /// Deadline used when the request carries no attempt budget. A blocking read cannot be
    /// interrupted, so this bounds how long an abandoned call can keep its worker alive.
    pub const DEFAULT_DEADLINE: Duration = Duration::from_secs(120);

    /// Builds a configuration. `base_url` is the API root (for example
    /// `https://api.openai.com/v1`); plain `http` is accepted only for a loopback host so a
    /// credential is never sent in the clear across a network.
    pub fn new(base_url: &str, api_key: Secret) -> Result<Self, ConfigError> {
        let trimmed = base_url.trim().trim_end_matches('/');
        let rest = if let Some(rest) = trimmed.strip_prefix("https://") {
            rest
        } else if let Some(rest) = trimmed.strip_prefix("http://") {
            let host = rest.split(['/', ':']).next().unwrap_or_default();
            if !matches!(host, "127.0.0.1" | "localhost" | "[::1]") {
                return Err(ConfigError(
                    "plain http is only allowed for a loopback host".into(),
                ));
            }
            rest
        } else {
            return Err(ConfigError("base_url must start with https://".into()));
        };
        if rest.is_empty() || rest.starts_with('/') || trimmed.contains(char::is_whitespace) {
            return Err(ConfigError("base_url has no host".into()));
        }
        if trimmed.contains('@') || trimmed.contains('?') || trimmed.contains('#') {
            return Err(ConfigError(
                "base_url must not carry credentials, a query or a fragment".into(),
            ));
        }
        if api_key.expose().is_empty() {
            return Err(ConfigError("api_key is empty".into()));
        }
        Ok(Self {
            base_url: trimmed.to_owned(),
            api_key,
            connect_timeout: Self::CONNECT_TIMEOUT,
            default_deadline: Self::DEFAULT_DEADLINE,
        })
    }

    /// Sets the connect timeout.
    #[must_use]
    pub fn with_connect_timeout(mut self, timeout: Duration) -> Self {
        self.connect_timeout = timeout;
        self
    }

    /// Sets the deadline used when a request has no attempt budget.
    #[must_use]
    pub fn with_default_deadline(mut self, deadline: Duration) -> Self {
        self.default_deadline = deadline;
        self
    }

    pub(crate) fn endpoint(&self) -> String {
        format!("{}/chat/completions", self.base_url)
    }
}
