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

/// Default connect timeout.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Deadline used when the request carries no attempt budget. A blocking read cannot be
/// interrupted, so this bounds how long an abandoned call can keep its worker alive.
pub const DEFAULT_DEADLINE: Duration = Duration::from_secs(120);

/// Connection settings every provider shares.
#[derive(Clone, Debug)]
pub struct Common {
    base_url: String,
    pub(crate) key: Option<Secret>,
    pub(crate) extra_headers: Vec<(String, String)>,
    pub(crate) connect_timeout: Duration,
    pub(crate) default_deadline: Duration,
}

/// Headers the host may not set: the provider adapter owns them.
const RESERVED: [&str; 8] = [
    "authorization",
    "x-api-key",
    "content-type",
    "content-length",
    "host",
    "accept",
    "anthropic-version",
    "transfer-encoding",
];

impl Common {
    pub(crate) fn new(base_url: &str, key: Option<Secret>) -> Result<Self, ConfigError> {
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
        if let Some(key) = &key
            && key.expose().is_empty()
        {
            return Err(ConfigError("api_key is empty".into()));
        }
        Ok(Self {
            base_url: trimmed.to_owned(),
            key,
            extra_headers: Vec::new(),
            connect_timeout: CONNECT_TIMEOUT,
            default_deadline: DEFAULT_DEADLINE,
        })
    }

    pub(crate) fn add_header(&mut self, name: &str, value: &str) -> Result<(), ConfigError> {
        let valid_name = !name.is_empty()
            && name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
        if !valid_name {
            return Err(ConfigError(format!("{name:?} is not a valid header name")));
        }
        if RESERVED.contains(&name.to_ascii_lowercase().as_str()) {
            return Err(ConfigError(format!(
                "the {name} header is set by the adapter"
            )));
        }
        if value.bytes().any(|b| b == b'\r' || b == b'\n' || b == 0) {
            return Err(ConfigError(
                "header values may not contain line breaks".into(),
            ));
        }
        self.extra_headers.push((name.to_owned(), value.to_owned()));
        Ok(())
    }

    pub(crate) fn endpoint(&self, path: &str) -> String {
        format!("{}/{path}", self.base_url)
    }
}

macro_rules! shared_builders {
    () => {
        /// Sets the connect timeout.
        #[must_use]
        pub fn with_connect_timeout(mut self, timeout: Duration) -> Self {
            self.common.connect_timeout = timeout;
            self
        }

        /// Sets the deadline used when a request has no attempt budget.
        #[must_use]
        pub fn with_default_deadline(mut self, deadline: Duration) -> Self {
            self.common.default_deadline = deadline;
            self
        }

        /// Adds a request header, for example an attribution header. The adapter owns
        /// authentication, content type and the Anthropic version header, which cannot be set.
        pub fn with_header(mut self, name: &str, value: &str) -> Result<Self, ConfigError> {
            self.common.add_header(name, value)?;
            Ok(self)
        }
    };
}

/// Settings for one OpenAI-compatible endpoint (OpenAI, OpenRouter, LM Studio, and others).
#[derive(Clone, Debug)]
pub struct OpenAiConfig {
    pub(crate) common: Common,
    pub(crate) template_thinking: Option<bool>,
}

impl OpenAiConfig {
    /// Default connect timeout.
    pub const CONNECT_TIMEOUT: Duration = CONNECT_TIMEOUT;
    /// Default deadline when a request carries no attempt budget.
    pub const DEFAULT_DEADLINE: Duration = DEFAULT_DEADLINE;

    /// An endpoint that needs a bearer token. `base_url` is the API root (for example
    /// `https://api.openai.com/v1` or `https://openrouter.ai/api/v1`); plain `http` is accepted
    /// only for a loopback host so a credential is never sent in the clear across a network.
    pub fn new(base_url: &str, api_key: Secret) -> Result<Self, ConfigError> {
        Ok(Self {
            common: Common::new(base_url, Some(api_key))?,
            template_thinking: None,
        })
    }

    /// An endpoint that takes no credential, such as a local LM Studio server
    /// (`http://localhost:1234/v1`). No `Authorization` header is sent.
    pub fn without_key(base_url: &str) -> Result<Self, ConfigError> {
        Ok(Self {
            common: Common::new(base_url, None)?,
            template_thinking: None,
        })
    }

    /// Sends `"chat_template_kwargs":{"enable_thinking":<enable>}` at the top level of every
    /// request body, which is where servers that render a chat template (LM Studio, vLLM and
    /// similar, for models such as Qwen) read it. This is a host setting for that vendor
    /// extension, not FX's reasoning effort, and it is off unless set because servers that do
    /// not know the field may reject it.
    #[must_use]
    pub fn with_chat_template_thinking(mut self, enable: bool) -> Self {
        self.template_thinking = Some(enable);
        self
    }

    shared_builders!();
}

/// Settings for the Anthropic Messages API.
#[derive(Clone, Debug)]
pub struct AnthropicConfig {
    pub(crate) common: Common,
    pub(crate) version: String,
    pub(crate) default_max_tokens: u32,
}

impl AnthropicConfig {
    /// The API version header Anthropic documents, used unless the host sets another.
    pub const VERSION: &'static str = "2023-06-01";
    /// Anthropic requires `max_tokens`. This is the value used when the request does not carry
    /// one; it is a host setting, never a hidden constant.
    pub const DEFAULT_MAX_TOKENS: u32 = 4096;

    /// `base_url` is the API root, for example `https://api.anthropic.com/v1`.
    pub fn new(base_url: &str, api_key: Secret) -> Result<Self, ConfigError> {
        Ok(Self {
            common: Common::new(base_url, Some(api_key))?,
            version: Self::VERSION.to_owned(),
            default_max_tokens: Self::DEFAULT_MAX_TOKENS,
        })
    }

    /// Sets the `anthropic-version` header.
    pub fn with_version(mut self, version: &str) -> Result<Self, ConfigError> {
        if version.is_empty()
            || version
                .bytes()
                .any(|b| !(b.is_ascii_alphanumeric() || b == b'-'))
        {
            return Err(ConfigError("the Anthropic version is not valid".into()));
        }
        self.version = version.to_owned();
        Ok(self)
    }

    /// Sets the `max_tokens` used when a request does not carry `max_output_tokens`.
    #[must_use]
    pub fn with_default_max_tokens(mut self, tokens: u32) -> Self {
        self.default_max_tokens = tokens.max(1);
        self
    }

    shared_builders!();
}
