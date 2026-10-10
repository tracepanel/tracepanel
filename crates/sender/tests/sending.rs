//! The sender against a stand-in for the cloud's ingest: a plain HTTP server on a free port.

use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tracepanel_sender::{Config, Options, Report, Sender};

/// One request as the stand-in received it.
#[derive(Debug, Clone)]
struct Request {
    line: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
    at: Instant,
}

impl Request {
    /// The traces in the body, unpacked.
    fn traces(&self) -> Vec<Value> {
        let json = zstd::decode_all(&self.body[..]).unwrap();
        serde_json::from_slice(&json).unwrap()
    }
}

/// Answers each request with the next of `answers` (status, extra headers), then 202 for good.
struct Ingest {
    url: String,
    requests: Arc<Mutex<Vec<Request>>>,
}

impl Ingest {
    fn start(answers: &[(u16, &str)]) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let mut answers: VecDeque<(u16, String)> = answers
            .iter()
            .map(|(status, headers)| (*status, (*headers).to_owned()))
            .collect();
        let seen = requests.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 {
                    continue;
                }
                let mut headers = HashMap::new();
                loop {
                    let mut header = String::new();
                    reader.read_line(&mut header).unwrap();
                    let header = header.trim_end();
                    if header.is_empty() {
                        break;
                    }
                    let (name, value) = header.split_once(':').unwrap();
                    headers.insert(name.to_ascii_lowercase(), value.trim().to_owned());
                }
                let length: usize = headers
                    .get("content-length")
                    .map_or(0, |length| length.parse().unwrap());
                let mut body = vec![0; length];
                reader.read_exact(&mut body).unwrap();
                seen.lock().unwrap().push(Request {
                    line: line.trim_end().to_owned(),
                    headers,
                    body,
                    at: Instant::now(),
                });
                let (status, extra) = answers.pop_front().unwrap_or((202, String::new()));
                let reply = format!(
                    "HTTP/1.1 {status} X\r\n{extra}Content-Length: 2\r\nConnection: close\r\n\r\n{{}}"
                );
                let _ = stream.write_all(reply.as_bytes());
            }
        });
        Self { url, requests }
    }

    fn requests(&self) -> Vec<Request> {
        self.requests.lock().unwrap().clone()
    }

    /// Wait until this many requests came in, or fail.
    fn wait_for(&self, count: usize) -> Vec<Request> {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            let requests = self.requests();
            if requests.len() >= count {
                return requests;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("{count} requests expected, got {}", self.requests().len());
    }
}

fn config(url: &str) -> Config {
    Config {
        key: "secret-key".into(),
        url: url.into(),
        environment: "staging".into(),
    }
}

fn options() -> Options {
    Options {
        flush_every: Duration::from_millis(20),
        timeout: Duration::from_secs(2),
        min_backoff: Duration::from_millis(20),
        max_backoff: Duration::from_millis(200),
        ..Options::default()
    }
}

fn spool() -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "tracepanel-sender-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn spooled(dir: &Path) -> usize {
    std::fs::read_dir(dir)
        .unwrap()
        .filter(|entry| {
            entry
                .as_ref()
                .unwrap()
                .path()
                .extension()
                .is_some_and(|extension| extension == "zst")
        })
        .count()
}

fn trace(id: &str) -> String {
    json!({
        "id": id,
        "kind": "http",
        "name": "GET /posts/",
        "start": 1_791_633_600_250_000_i64,
        "duration": 48_000,
        "status": "ok",
        "attrs": {"service.name": "blog", "user.username": "ada"},
        "spans": [{"kind": "sql", "attrs": {"db.statement": "SELECT 1", "db.params": "[1]"}}],
        "logs": [],
        "errors": [],
        "links": [],
        "issues": [{"fingerprint": "5f2c9a8e1b7d4c3a", "kind": "n+1"}]
    })
    .to_string()
}

#[test]
fn a_batch_goes_as_zstd_json_with_the_key() {
    let ingest = Ingest::start(&[]);
    let dir = spool();
    let sender = Sender::start(config(&ingest.url), dir.clone(), options()).unwrap();

    sender.offer(trace("01K7B2Y7Q8M3E5R9T1V4W6X8Z0"));
    sender.offer(trace("01K7B2Y7Q8M3E5R9T1V4W6X8Z1"));
    let requests = ingest.wait_for(1);
    let report = sender.stop();

    let request = &requests[0];
    assert_eq!(request.line, "POST /v1/traces HTTP/1.1");
    assert_eq!(request.headers["authorization"], "Bearer secret-key");
    assert_eq!(request.headers["content-encoding"], "zstd");
    assert_eq!(request.headers["content-type"], "application/json");

    let traces = request.traces();
    assert_eq!(traces.len(), 2);
    assert_eq!(
        traces[0],
        json!({
            "id": "01K7B2Y7Q8M3E5R9T1V4W6X8Z0",
            "kind": "http",
            "name": "GET /posts/",
            "start": 1_791_633_600_250_000_i64,
            "duration": 48_000,
            "status": "ok",
            "attrs": {"service.name": "blog", "deployment.environment.name": "staging"},
            "spans": [{"kind": "sql", "attrs": {"db.statement": "SELECT 1"}}],
            "logs": [],
            "errors": [],
            "links": [],
            "issues": [{"fingerprint": "5f2c9a8e1b7d4c3a", "kind": "n+1"}]
        })
    );

    assert_eq!(
        report,
        Report {
            sent: 2,
            dropped: 0,
            spooled: 0
        }
    );
    assert_eq!(spooled(&dir), 0);
}

#[test]
fn a_batch_holds_no_more_than_it_is_allowed() {
    let ingest = Ingest::start(&[]);
    let options = Options {
        batch: 2,
        ..options()
    };
    let sender = Sender::start(config(&ingest.url), spool(), options).unwrap();

    for id in ["A", "B", "C"] {
        sender.offer(trace(id));
    }
    let requests = ingest.wait_for(2);
    sender.stop();

    let sizes: Vec<usize> = requests
        .iter()
        .map(|request| request.traces().len())
        .collect();
    assert_eq!(sizes, [2, 1]);
}

#[test]
fn a_cloud_that_is_down_is_tried_again_with_the_same_batch() {
    let ingest = Ingest::start(&[(503, ""), (500, "")]);
    let dir = spool();
    let sender = Sender::start(config(&ingest.url), dir.clone(), options()).unwrap();

    sender.offer(trace("A"));
    let requests = ingest.wait_for(3);
    let report = sender.stop();

    assert_eq!(requests[0].body, requests[1].body);
    assert_eq!(requests[1].body, requests[2].body);
    // The second wait is twice the first.
    assert!(requests[2].at - requests[1].at >= requests[1].at - requests[0].at);

    assert_eq!(report.sent, 1);
    assert_eq!(spooled(&dir), 0);
}

#[test]
fn too_many_requests_waits_as_long_as_the_cloud_said() {
    let ingest = Ingest::start(&[(429, "Retry-After: 1\r\n")]);
    let sender = Sender::start(config(&ingest.url), spool(), options()).unwrap();

    sender.offer(trace("A"));
    let requests = ingest.wait_for(2);
    sender.stop();

    assert!(requests[1].at - requests[0].at >= Duration::from_secs(1));
}

#[test]
fn a_batch_refused_for_good_is_not_sent_again() {
    let ingest = Ingest::start(&[(401, "")]);
    let dir = spool();
    let sender = Sender::start(config(&ingest.url), dir.clone(), options()).unwrap();

    sender.offer(trace("A"));
    ingest.wait_for(1);
    std::thread::sleep(Duration::from_millis(200));
    let report = sender.stop();

    assert_eq!(ingest.requests().len(), 1);
    assert_eq!(
        report,
        Report {
            sent: 0,
            dropped: 1,
            spooled: 0
        }
    );
    assert_eq!(spooled(&dir), 0);
}

#[test]
fn what_the_cloud_did_not_take_is_sent_by_the_next_agent() {
    // Nothing listens on a port that was just freed.
    let closed = {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        format!("http://{}", listener.local_addr().unwrap())
    };
    let dir = spool();
    let first = Sender::start(config(&closed), dir.clone(), options()).unwrap();
    first.offer(trace("A"));
    first.offer(trace("B"));
    std::thread::sleep(Duration::from_millis(100));
    let report = first.stop();

    assert_eq!(
        report,
        Report {
            sent: 0,
            dropped: 0,
            spooled: 2
        }
    );
    assert_eq!(spooled(&dir), 1);

    let ingest = Ingest::start(&[]);
    let next = Sender::start(config(&ingest.url), dir.clone(), options()).unwrap();
    let requests = ingest.wait_for(1);
    let report = next.stop();

    let ids: Vec<Value> = requests[0]
        .traces()
        .iter()
        .map(|trace| trace["id"].clone())
        .collect();
    assert_eq!(ids, [json!("A"), json!("B")]);
    assert_eq!(report.sent, 2);
    assert_eq!(spooled(&dir), 0);
}

#[test]
fn a_full_spool_drops_its_oldest_batch() {
    let closed = {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        format!("http://{}", listener.local_addr().unwrap())
    };
    let dir = spool();
    let options = Options {
        batch: 1,
        spool_bytes: 1,
        ..options()
    };
    let sender = Sender::start(config(&closed), dir.clone(), options).unwrap();

    for id in ["A", "B", "C"] {
        sender.offer(trace(id));
    }
    std::thread::sleep(Duration::from_millis(100));
    let report = sender.stop();

    assert_eq!(
        report,
        Report {
            sent: 0,
            dropped: 2,
            spooled: 1
        }
    );
    assert_eq!(spooled(&dir), 1);
}
