//! A deterministic mock HTTP server on loopback. No live credentials, no external network.
//!
//! Each accepted connection takes the next scripted [`Reply`]; the server records every
//! request so tests can prove how many calls were made and what was (not) sent.

use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

/// What the server does with one connection.
#[derive(Clone)]
pub enum Reply {
    /// Status line, extra headers, body chunks (each flushed separately), then close.
    Respond {
        status: u16,
        headers: Vec<(&'static str, String)>,
        chunks: Vec<Vec<u8>>,
    },
    /// Status and headers, the chunks, then hold the connection open until the server stops.
    Stall { chunks: Vec<Vec<u8>> },
    /// Accept, read the request, send nothing and hold the connection open.
    Silent,
    /// Accept and close without reading or answering.
    Close,
}

/// One recorded request.
#[derive(Clone, Debug)]
pub struct Recorded {
    pub head: String,
    pub body: String,
}

pub struct Server {
    pub base_url: String,
    pub requests: Arc<Mutex<Vec<Recorded>>>,
    connections: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Server {
    pub fn start(script: Vec<Reply>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let connections = Arc::new(AtomicUsize::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let (r, c, s) = (requests.clone(), connections.clone(), stop.clone());
        let thread = std::thread::spawn(move || {
            let mut script = script.into_iter();
            let mut held: Vec<TcpStream> = Vec::new();
            while !s.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        c.fetch_add(1, Ordering::SeqCst);
                        // An unscripted connection is a bug in the code under test.
                        let reply = script.next().unwrap_or(Reply::Close);
                        if let Some(kept) = serve(stream, reply, &r, &s) {
                            held.push(kept);
                        }
                    }
                    Err(_) => std::thread::sleep(Duration::from_millis(2)),
                }
            }
            for stream in held {
                let _ = stream.shutdown(Shutdown::Both);
            }
        });
        Self {
            base_url: format!("http://127.0.0.1:{port}/v1"),
            requests,
            connections,
            stop,
            thread: Some(thread),
        }
    }

    /// How many connections the code under test opened.
    pub fn connections(&self) -> usize {
        self.connections.load(Ordering::SeqCst)
    }

    pub fn recorded(&self) -> Vec<Recorded> {
        self.requests.lock().unwrap().clone()
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

fn read_request(stream: &mut TcpStream) -> Option<Recorded> {
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    let mut data = Vec::new();
    let mut buf = [0u8; 2048];
    let head_end = loop {
        let n = stream.read(&mut buf).ok()?;
        if n == 0 {
            return None;
        }
        data.extend_from_slice(&buf[..n]);
        if let Some(i) = data.windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
    };
    let head = String::from_utf8_lossy(&data[..head_end]).into_owned();
    let length = head
        .lines()
        .find_map(|l| {
            l.to_ascii_lowercase()
                .strip_prefix("content-length:")
                .map(|v| v.trim().parse::<usize>().unwrap_or(0))
        })
        .unwrap_or(0);
    while data.len() < head_end + length {
        let n = stream.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        data.extend_from_slice(&buf[..n]);
    }
    let body = String::from_utf8_lossy(&data[head_end..]).into_owned();
    Some(Recorded { head, body })
}

fn serve(
    mut stream: TcpStream,
    reply: Reply,
    requests: &Arc<Mutex<Vec<Recorded>>>,
    stop: &Arc<AtomicBool>,
) -> Option<TcpStream> {
    let _ = stream.set_nonblocking(false);
    if matches!(reply, Reply::Close) {
        return None;
    }
    let recorded = read_request(&mut stream)?;
    requests.lock().unwrap().push(recorded);
    let _ = stop;
    match reply {
        Reply::Respond {
            status,
            headers,
            chunks,
        } => {
            let mut head = format!("HTTP/1.1 {status} X\r\nconnection: close\r\n");
            for (k, v) in headers {
                head.push_str(&format!("{k}: {v}\r\n"));
            }
            head.push_str("\r\n");
            let _ = stream.write_all(head.as_bytes());
            for chunk in chunks {
                if stream.write_all(&chunk).is_err() {
                    break;
                }
                let _ = stream.flush();
                std::thread::sleep(Duration::from_millis(3));
            }
            let _ = stream.shutdown(Shutdown::Both);
            None
        }
        Reply::Stall { chunks } => {
            let head =
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n";
            let _ = stream.write_all(head.as_bytes());
            for chunk in chunks {
                let _ = stream.write_all(&chunk);
                let _ = stream.flush();
            }
            Some(stream)
        }
        Reply::Silent => Some(stream),
        Reply::Close => None,
    }
}

/// An SSE `data:` event.
pub fn event(json: &str) -> Vec<u8> {
    format!("data: {json}\n\n").into_bytes()
}

pub fn delta(text: &str) -> Vec<u8> {
    event(&format!(
        r#"{{"model":"mock-1","choices":[{{"index":0,"delta":{{"content":{}}},"finish_reason":null}}]}}"#,
        serde_json::to_string(text).unwrap()
    ))
}

pub fn finish(reason: &str) -> Vec<u8> {
    event(&format!(
        r#"{{"model":"mock-1","choices":[{{"index":0,"delta":{{}},"finish_reason":"{reason}"}}]}}"#
    ))
}

pub fn usage(input: u64, output: u64) -> Vec<u8> {
    event(&format!(
        r#"{{"model":"mock-1","choices":[],"usage":{{"prompt_tokens":{input},"completion_tokens":{output},"prompt_tokens_details":{{"cached_tokens":2}},"completion_tokens_details":{{"reasoning_tokens":1}}}}}}"#
    ))
}

pub fn done() -> Vec<u8> {
    b"data: [DONE]\n\n".to_vec()
}

pub fn sse(chunks: Vec<Vec<u8>>) -> Reply {
    Reply::Respond {
        status: 200,
        headers: vec![("content-type", "text/event-stream".to_owned())],
        chunks,
    }
}

pub fn http(status: u16, headers: Vec<(&'static str, String)>, body: &str) -> Reply {
    let mut headers = headers;
    headers.push(("content-type", "application/json".to_owned()));
    headers.push(("content-length", body.len().to_string()));
    Reply::Respond {
        status,
        headers,
        chunks: vec![body.as_bytes().to_vec()],
    }
}
