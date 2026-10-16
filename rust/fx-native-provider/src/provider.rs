//! The OpenAI-compatible chat-completions provider.
//!
//! One `invoke` starts one worker thread that makes one HTTP request and streams its
//! response into a channel; `poll` drains the channel with a short wait. There is no retry,
//! no redirect following and no second request.

use std::collections::VecDeque;
use std::io::Read;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};

use fx_core::{AttemptBudget, Request};
use fx_single_attempt::{
    AbortReport, Observed, PortFailure, PortFailureKind, PortItem, PortPoll, PortSupport,
    PortUsage, ProviderPort, Terminal,
};

use crate::body;
use crate::config::OpenAiConfig;
use crate::secret::Secret;
use crate::sse::{Decoded, Framer, decode};

/// How long one `poll` waits for the worker before returning empty.
const POLL_WAIT: Duration = Duration::from_millis(25);
/// The most of an error body that is read and kept.
const ERROR_BODY_LIMIT: u64 = 8 * 1024;
const MESSAGE_LIMIT: usize = 512;

/// The native provider for OpenAI-compatible `/chat/completions` endpoints (streaming).
///
/// Carries text conversations only. See `docs/rebuild/NATIVE_PROVIDER.md`.
#[derive(Debug)]
pub struct OpenAiCompatible {
    config: OpenAiConfig,
}

impl OpenAiCompatible {
    /// Creates the provider from host configuration.
    pub fn new(config: OpenAiConfig) -> Self {
        Self { config }
    }
}

enum Message {
    /// Items decoded from the stream; the first message of this kind proves output arrived.
    Items(Vec<PortItem>),
    Failed(PortFailure),
    Ended,
}

/// Per-call state: the receiving end of the worker and what has been observed.
#[derive(Debug)]
pub struct OpenAiCall {
    rx: Receiver<Message>,
    cancel: Arc<AtomicBool>,
    deadline: Instant,
    pending: VecDeque<PortItem>,
    failure: Option<PortFailure>,
    observed: Observed,
    ended: bool,
    aborted: bool,
}

impl std::fmt::Debug for Message {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Message")
    }
}

fn failure(kind: PortFailureKind, message: impl Into<String>, observed: Observed) -> PortFailure {
    PortFailure {
        kind,
        message: message.into(),
        observed,
        status: None,
        retry_after: None,
    }
}

impl ProviderPort for OpenAiCompatible {
    type Call = OpenAiCall;

    fn support(&self) -> PortSupport {
        // Text only. Anything else is refused by the capability before `invoke`.
        PortSupport::default()
    }

    fn invoke(
        &mut self,
        request: &Request,
        budget: Option<AttemptBudget>,
    ) -> Result<OpenAiCall, PortFailure> {
        let body = body::build(request)
            .map_err(|why| failure(PortFailureKind::Unsupported, why, Observed::NotInvoked))?;
        let deadline_after = budget.map_or(self.config.default_deadline, |b| b.0);
        let (tx, rx) = mpsc::channel();
        let cancel = Arc::new(AtomicBool::new(false));
        let worker = Worker {
            url: self.config.endpoint(),
            key: self.config.api_key.clone(),
            connect_timeout: self.config.connect_timeout,
            deadline: deadline_after,
            cancel: Arc::clone(&cancel),
            tx,
        };
        std::thread::Builder::new()
            .name("fx-native-provider".into())
            .spawn(move || worker.run(&body))
            .map_err(|_| {
                failure(
                    PortFailureKind::ProviderError,
                    "the worker thread could not start",
                    Observed::NotInvoked,
                )
            })?;
        Ok(OpenAiCall {
            rx,
            cancel,
            deadline: Instant::now() + deadline_after,
            pending: VecDeque::new(),
            failure: None,
            observed: Observed::Invoked,
            ended: false,
            aborted: false,
        })
    }

    fn poll(&mut self, call: &mut OpenAiCall, max_items: usize) -> Result<PortPoll, PortFailure> {
        if call.aborted {
            return Err(failure(
                PortFailureKind::Aborted,
                "the call was aborted",
                call.observed,
            ));
        }
        if call.pending.is_empty() && call.failure.is_none() && !call.ended {
            match call.rx.recv_timeout(POLL_WAIT) {
                Ok(message) => call.accept(message),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => {
                    call.failure = Some(failure(
                        PortFailureKind::ProviderError,
                        "the provider worker stopped unexpectedly",
                        call.observed,
                    ));
                }
            }
        }
        // Whatever else is already waiting, without blocking.
        while call.failure.is_none() && !call.ended && call.pending.len() < max_items {
            match call.rx.try_recv() {
                Ok(message) => call.accept(message),
                Err(_) => break,
            }
        }
        let take = max_items.min(call.pending.len());
        let items: Vec<PortItem> = call.pending.drain(..take).collect();
        if items.is_empty() && call.pending.is_empty() {
            if let Some(f) = call.failure.take() {
                return Err(f);
            }
            if !call.ended && Instant::now() >= call.deadline {
                call.cancel.store(true, Ordering::SeqCst);
                return Err(failure(
                    PortFailureKind::Timeout,
                    "the attempt budget elapsed",
                    call.observed,
                ));
            }
        }
        let ended = call.ended && call.pending.is_empty() && call.failure.is_none();
        Ok(PortPoll {
            items,
            observed: call.observed,
            ended,
        })
    }

    fn abort(&mut self, call: &mut OpenAiCall) -> AbortReport {
        call.aborted = true;
        call.cancel.store(true, Ordering::SeqCst);
        // A blocking read cannot be interrupted, so the closing of the transport is not
        // observed here. The worker stops at its next read or at its deadline.
        AbortReport {
            transport_closed: false,
        }
    }

    fn release(&mut self, call: OpenAiCall) {
        call.cancel.store(true, Ordering::SeqCst);
        drop(call);
    }
}

impl OpenAiCall {
    fn accept(&mut self, message: Message) {
        match message {
            Message::Items(items) => {
                self.observed = Observed::OutputObserved;
                self.pending.extend(items);
            }
            Message::Failed(f) => {
                if f.observed > self.observed {
                    self.observed = f.observed;
                }
                self.failure = Some(PortFailure {
                    observed: self.observed,
                    ..f
                });
            }
            Message::Ended => self.ended = true,
        }
    }
}

struct Worker {
    url: String,
    key: Secret,
    connect_timeout: Duration,
    deadline: Duration,
    cancel: Arc<AtomicBool>,
    tx: Sender<Message>,
}

impl Worker {
    fn run(self, body: &[u8]) {
        let result = self.exchange(body);
        let _ = self.tx.send(match result {
            Ok(()) => Message::Ended,
            Err(f) => Message::Failed(f),
        });
    }

    fn scrub(&self, text: &str) -> String {
        let mut text = self.key.scrub(text);
        if text.len() > MESSAGE_LIMIT {
            let mut cut = MESSAGE_LIMIT;
            while !text.is_char_boundary(cut) {
                cut -= 1;
            }
            text.truncate(cut);
        }
        text
    }

    fn exchange(&self, body: &[u8]) -> Result<(), PortFailure> {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .max_redirects(0)
            .proxy(None)
            .timeout_connect(Some(self.connect_timeout))
            .timeout_global(Some(self.deadline))
            .build()
            .into();
        let sent = agent
            .post(&self.url)
            .header("authorization", format!("Bearer {}", self.key.expose()))
            .header("accept", "text/event-stream")
            .header("content-type", "application/json")
            .send(body);
        let mut response = match sent {
            Ok(response) => response,
            Err(error) => return Err(self.transport_failure(&error)),
        };
        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
            let retry_after = response
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.trim().parse::<u64>().ok())
                .map(Duration::from_secs);
            let mut text = String::new();
            let _ = response
                .body_mut()
                .as_reader()
                .take(ERROR_BODY_LIMIT)
                .read_to_string(&mut text);
            let detail = serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .and_then(|v| v.pointer("/error/message")?.as_str().map(str::to_owned))
                .unwrap_or(text);
            return Err(PortFailure {
                kind: PortFailureKind::ProviderError,
                message: self.scrub(&format!("HTTP {status}: {}", detail.trim())),
                observed: Observed::Invoked,
                status: Some(status),
                retry_after,
            });
        }
        let is_stream = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| {
                v.trim_start()
                    .to_ascii_lowercase()
                    .starts_with("text/event-stream")
            });
        if !is_stream {
            return Err(failure(
                PortFailureKind::MalformedOutput,
                "the response is not an event stream",
                Observed::Invoked,
            ));
        }
        self.stream(response.body_mut().as_reader())
    }

    /// Every failure after `invoke` returned is at least `Invoked`: the call had started, and
    /// a connect failure seen later cannot prove nothing left the process (a send can fail
    /// part-way), so it is never reported as `NotInvoked`.
    fn transport_failure(&self, error: &ureq::Error) -> PortFailure {
        let kind = match error {
            ureq::Error::Timeout(_) => PortFailureKind::Timeout,
            _ => PortFailureKind::ProviderError,
        };
        failure(kind, self.scrub(&error.to_string()), Observed::Invoked)
    }

    fn stream(&self, mut reader: impl Read) -> Result<(), PortFailure> {
        let mut framer = Framer::default();
        let mut buf = [0u8; 4096];
        let mut seen_output = false;
        let mut finish: Option<String> = None;
        let mut model: Option<String> = None;
        let mut usage: Option<PortUsage> = None;
        let mut refused = false;
        let observed = |seen: bool| {
            if seen {
                Observed::OutputObserved
            } else {
                Observed::Invoked
            }
        };
        loop {
            if self.cancel.load(Ordering::SeqCst) {
                return Ok(());
            }
            let n = match reader.read(&mut buf) {
                Ok(0) => {
                    // A complete 2xx response was received, so the provider answered even if
                    // it said nothing before it stopped.
                    return Err(failure(
                        PortFailureKind::IncompleteStream,
                        "the stream ended without its terminal marker",
                        Observed::OutputObserved,
                    ));
                }
                Ok(n) => n,
                Err(error) => {
                    let timed_out = error.to_string().to_ascii_lowercase().contains("timeout")
                        || error.kind() == std::io::ErrorKind::TimedOut;
                    // A broken connection is an error the transport raised, not a stream that
                    // ended; the text already delivered is kept by the executor either way.
                    let kind = if timed_out {
                        PortFailureKind::Timeout
                    } else {
                        PortFailureKind::ProviderError
                    };
                    return Err(failure(
                        kind,
                        self.scrub(&error.to_string()),
                        observed(seen_output),
                    ));
                }
            };
            let frames = framer.push(&buf[..n]).map_err(|why| {
                failure(PortFailureKind::MalformedOutput, why, observed(seen_output))
            })?;
            for crate::sse::Frame::Data(data) in frames {
                if data.trim() == "[DONE]" {
                    if finish.is_none() {
                        return Err(failure(
                            PortFailureKind::MalformedOutput,
                            "the stream ended without a finish reason",
                            observed(seen_output),
                        ));
                    }
                    let done = PortItem::Done {
                        usage: usage.take(),
                        finish_reason: if refused {
                            Some("content_filter".to_owned())
                        } else {
                            finish.take()
                        },
                        model: model.take(),
                        terminal: Terminal::ProviderMarker,
                    };
                    self.send(vec![done]);
                    return Ok(());
                }
                let chunk = match decode(&data) {
                    Ok(Decoded::Chunk(chunk)) => chunk,
                    Ok(Decoded::ProviderError(message)) => {
                        return Err(failure(
                            PortFailureKind::ProviderError,
                            self.scrub(&message),
                            observed(seen_output),
                        ));
                    }
                    Err(why) => {
                        return Err(failure(
                            PortFailureKind::MalformedOutput,
                            why,
                            observed(seen_output),
                        ));
                    }
                };
                seen_output = true;
                let mut items = Vec::new();
                if !chunk.text.is_empty() {
                    items.push(PortItem::Text(chunk.text));
                }
                if !chunk.refusal.is_empty() {
                    refused = true;
                    items.push(PortItem::Text(chunk.refusal));
                }
                if chunk.finish_reason.is_some() {
                    finish = chunk.finish_reason;
                }
                if chunk.model.is_some() {
                    model = chunk.model;
                }
                if chunk.usage.is_some() {
                    usage = chunk.usage;
                }
                // The first chunk always reports arrival, even when it carries no text.
                self.send(items);
            }
        }
    }

    fn send(&self, items: Vec<PortItem>) {
        let _ = self.tx.send(Message::Items(items));
    }
}
