//! Sends the traces the agent keeps to Tracepanel Cloud, when `TRACEPANEL_KEY` says so.
//!
//! Settings come from the environment, which an agent an SDK starts inherits from the app (a key on the command
//! line would show in every process list):
//!
//! - `TRACEPANEL_KEY`: the project's key; without it nothing is sent.
//! - `TRACEPANEL_CLOUD_URL`: the ingest to send to, `DEFAULT_URL` unless set (locally `http://localhost:8102`).
//! - `TRACEPANEL_ENVIRONMENT`: where the traces come from, `production` unless set; 1 to 64 of a-z, 0-9, `.`, `_`
//!   and `-`. Stamped on each trace as `deployment.environment.name`, unless the trace names its own.
//!
//! Batches wait in `<store dir>/cloud/`.
//!
//! Intake never waits for it. Traces are handed over through a bounded queue and dropped when it is full; a thread
//! of its own strips what stays local, stamps the environment, packs batches with zstd into a spool directory, and
//! sends the spool oldest first. A batch leaves the spool once the cloud kept it, or refused it for good, so batches
//! outlive the cloud being down and the agent restarting. The spool is bounded too: past its size, the oldest batch
//! goes.

use serde_json::{Map, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, SyncSender, TrySendError, sync_channel};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Where traces go unless `TRACEPANEL_CLOUD_URL` says otherwise.
pub const DEFAULT_URL: &str = "https://ingest.tracepanel.dev";
/// What a trace that names no environment was sent from.
pub const DEFAULT_ENVIRONMENT: &str = "production";
/// The attribute the environment is stamped as, the OpenTelemetry name for it.
pub const ENVIRONMENT_ATTR: &str = "deployment.environment.name";
/// The most traces the cloud takes in one request.
pub const MAX_BATCH: usize = 2000;

/// Where to send, as whom, and from which environment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    pub key: String,
    pub url: String,
    pub environment: String,
}

impl Config {
    /// Read `TRACEPANEL_KEY`, `TRACEPANEL_CLOUD_URL` and `TRACEPANEL_ENVIRONMENT`; no key, no sending.
    pub fn from_env(var: impl Fn(&str) -> Option<String>) -> Result<Option<Self>, String> {
        let set = |name: &str| var(name).filter(|value| !value.trim().is_empty());
        let Some(key) = set("TRACEPANEL_KEY") else {
            return Ok(None);
        };
        let url = set("TRACEPANEL_CLOUD_URL").unwrap_or_else(|| DEFAULT_URL.into());
        if !url.starts_with("https://") && !url.starts_with("http://") {
            return Err(format!(
                "TRACEPANEL_CLOUD_URL takes an http(s) URL, not {url}"
            ));
        }
        let environment =
            set("TRACEPANEL_ENVIRONMENT").unwrap_or_else(|| DEFAULT_ENVIRONMENT.into());
        if !valid_environment(&environment) {
            return Err(format!(
                "TRACEPANEL_ENVIRONMENT takes 1 to 64 of a-z, 0-9, '.', '_' and '-', not {environment}"
            ));
        }
        Ok(Some(Self {
            key: key.trim().to_owned(),
            url: url.trim_end_matches('/').to_owned(),
            environment,
        }))
    }
}

fn valid_environment(name: &str) -> bool {
    (1..=64).contains(&name.len())
        && name
            .bytes()
            .all(|byte| matches!(byte, b'a'..=b'z' | b'0'..=b'9' | b'.' | b'_' | b'-'))
}

/// A trace as the cloud gets it: what stays local stripped, the environment stamped unless it names its own.
pub fn prepare(doc: &str, environment: &str) -> Option<Value> {
    let mut trace: Value = serde_json::from_str(doc).ok()?;
    let object = trace.as_object_mut()?;
    let attrs = object
        .entry("attrs")
        .or_insert_with(|| Value::Object(Map::new()));
    if let Some(attrs) = attrs.as_object_mut() {
        let named = attrs
            .get(ENVIRONMENT_ATTR)
            .is_some_and(|name| !name.is_null());
        if !named {
            attrs.insert(ENVIRONMENT_ATTR.into(), environment.into());
        }
    }
    tracepanel_protocol::local::strip(&mut trace);
    Some(trace)
}

/// How the sending thread paces itself; the defaults suit an agent, tests shorten them.
#[derive(Debug, Clone)]
pub struct Options {
    /// Traces waiting to be packed; a full queue drops them rather than slowing intake.
    pub queue: usize,
    /// Traces in one batch, at most `MAX_BATCH`.
    pub batch: usize,
    /// How long a batch fills before it is packed anyway.
    pub flush_every: Duration,
    /// The spool's size on disk; past it, the oldest batch goes.
    pub spool_bytes: u64,
    /// How long one request may take.
    pub timeout: Duration,
    /// The wait after the first failure, doubled after each next one up to `max_backoff`.
    pub min_backoff: Duration,
    pub max_backoff: Duration,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            queue: 10_000,
            batch: MAX_BATCH,
            flush_every: Duration::from_secs(5),
            spool_bytes: 64 << 20,
            timeout: Duration::from_secs(30),
            min_backoff: Duration::from_secs(1),
            max_backoff: Duration::from_secs(300),
        }
    }
}

/// What a sender did, told when it stops.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Report {
    /// Traces the cloud kept.
    pub sent: u64,
    /// Traces dropped: a full queue, a full spool, or a batch the cloud refused.
    pub dropped: u64,
    /// Traces still in the spool, for the next agent to send.
    pub spooled: u64,
}

enum Message {
    Trace(String),
    Stop,
}

/// The handle intake holds: `offer` never blocks.
pub struct Sender {
    queue: SyncSender<Message>,
    dropped: Arc<AtomicU64>,
    thread: JoinHandle<Report>,
}

impl Sender {
    /// Start sending, with `spool` as the directory batches wait in (made if missing).
    pub fn start(config: Config, spool: PathBuf, options: Options) -> std::io::Result<Self> {
        let spool = Spool::open(spool, options.spool_bytes)?;
        let (queue, traces) = sync_channel(options.queue);
        let dropped = Arc::new(AtomicU64::new(0));
        let worker = Worker::new(config, spool, options, dropped.clone());
        let thread = std::thread::Builder::new()
            .name("tracepanel-sender".into())
            .spawn(move || worker.run(&traces))?;
        Ok(Self {
            queue,
            dropped,
            thread,
        })
    }

    /// Hand a trace's document over, as the agent keeps it (issues included); dropped if the queue is full.
    pub fn offer(&self, doc: String) {
        if let Err(TrySendError::Full(_)) = self.queue.try_send(Message::Trace(doc))
            && self.dropped.fetch_add(1, Ordering::Relaxed) == 0
        {
            eprintln!("tracepanel-agent: cloud sending is behind: traces are being dropped");
        }
    }

    /// Pack what is waiting into the spool and stop; what was not sent is sent by the next agent.
    pub fn stop(self) -> Report {
        let _ = self.queue.send(Message::Stop);
        self.thread.join().unwrap_or_default()
    }
}

struct Worker {
    config: Config,
    spool: Spool,
    options: Options,
    dropped: Arc<AtomicU64>,
    agent: ureq::Agent,
    pending: Vec<Value>,
    filling_since: Option<Instant>,
    next_attempt: Instant,
    backoff: Duration,
    refused: HashSet<u16>,
    sent: u64,
}

/// What the cloud said to a batch.
enum Outcome {
    Kept,
    /// Refused for good: sending it again would get the same answer.
    Refused(u16),
    /// Try again later, no sooner than this if the cloud said so.
    Retry(Option<Duration>),
}

impl Worker {
    fn new(config: Config, spool: Spool, options: Options, dropped: Arc<AtomicU64>) -> Self {
        let agent = ureq::Agent::config_builder()
            .timeout_global(Some(options.timeout))
            .http_status_as_error(false)
            .user_agent(concat!("tracepanel-agent/", env!("CARGO_PKG_VERSION")))
            .build()
            .into();
        let backoff = options.min_backoff;
        Self {
            config,
            spool,
            options,
            dropped,
            agent,
            pending: Vec::new(),
            filling_since: None,
            next_attempt: Instant::now(),
            backoff,
            refused: HashSet::new(),
            sent: 0,
        }
    }

    fn run(mut self, traces: &Receiver<Message>) -> Report {
        loop {
            let wait = self.wait();
            match traces.recv_timeout(wait) {
                Ok(Message::Trace(doc)) => self.take(&doc),
                Ok(Message::Stop) | Err(RecvTimeoutError::Disconnected) => {
                    while let Ok(Message::Trace(doc)) = traces.try_recv() {
                        self.take(&doc);
                    }
                    self.pack();
                    break;
                }
                Err(RecvTimeoutError::Timeout) => {}
            }
            if self
                .filling_since
                .is_some_and(|since| since.elapsed() >= self.options.flush_every)
            {
                self.pack();
            }
            if Instant::now() >= self.next_attempt {
                self.deliver();
            }
        }
        let dropped = self.dropped.load(Ordering::Relaxed) + self.spool.dropped;
        Report {
            sent: self.sent,
            dropped,
            spooled: self.spool.traces(),
        }
    }

    /// How long to wait for the next trace: until a batch is due to be packed or the spool to be sent.
    fn wait(&self) -> Duration {
        let mut wait = self.options.flush_every;
        if let Some(since) = self.filling_since {
            wait = wait.min(self.options.flush_every.saturating_sub(since.elapsed()));
        }
        if !self.spool.is_empty() {
            wait = wait.min(self.next_attempt.saturating_duration_since(Instant::now()));
        }
        wait.max(Duration::from_millis(1))
    }

    fn take(&mut self, doc: &str) {
        let Some(trace) = prepare(doc, &self.config.environment) else {
            return;
        };
        self.pending.push(trace);
        self.filling_since.get_or_insert_with(Instant::now);
        if self.pending.len() >= self.options.batch.clamp(1, MAX_BATCH) {
            self.pack();
        }
    }

    fn pack(&mut self) {
        self.filling_since = None;
        if self.pending.is_empty() {
            return;
        }
        let batch = std::mem::take(&mut self.pending);
        if let Err(error) = self.spool.push(&batch) {
            self.dropped
                .fetch_add(batch.len() as u64, Ordering::Relaxed);
            eprintln!("tracepanel-agent: can't spool traces for the cloud: {error}");
        }
    }

    /// Send the spool oldest first, until it is empty or the cloud asks to wait.
    fn deliver(&mut self) {
        while let Some(batch) = self.spool.oldest() {
            let body = match std::fs::read(&batch.path) {
                Ok(body) => body,
                Err(_) => {
                    self.spool.remove(&batch);
                    continue;
                }
            };
            match self.post(body) {
                Outcome::Kept => {
                    self.sent += batch.traces;
                    self.spool.remove(&batch);
                    self.backoff = self.options.min_backoff;
                }
                Outcome::Refused(status) => {
                    if self.refused.insert(status) {
                        eprintln!(
                            "tracepanel-agent: the cloud refused traces ({status}); batches it refuses are dropped"
                        );
                    }
                    self.dropped.fetch_add(batch.traces, Ordering::Relaxed);
                    self.spool.remove(&batch);
                }
                Outcome::Retry(after) => {
                    let wait = after.unwrap_or(self.backoff).max(self.backoff);
                    self.next_attempt = Instant::now() + wait;
                    self.backoff = (self.backoff * 2).min(self.options.max_backoff);
                    return;
                }
            }
        }
    }

    fn post(&self, body: Vec<u8>) -> Outcome {
        let response = self
            .agent
            .post(format!("{}/v1/traces", self.config.url))
            .header("Authorization", format!("Bearer {}", self.config.key))
            .header("Content-Type", "application/json")
            .header("Content-Encoding", "zstd")
            .send(&body[..]);
        let response = match response {
            Ok(response) => response,
            Err(_) => return Outcome::Retry(None),
        };
        let status = response.status().as_u16();
        match status {
            200..=299 => Outcome::Kept,
            408 | 429 | 500..=599 => Outcome::Retry(
                response
                    .headers()
                    .get("retry-after")
                    .and_then(|value| value.to_str().ok())
                    .and_then(|value| value.trim().parse().ok())
                    .map(|seconds: u64| Duration::from_secs(seconds.min(3600))),
            ),
            _ => Outcome::Refused(status),
        }
    }
}

/// One batch waiting in the spool.
#[derive(Clone)]
struct Spooled {
    path: PathBuf,
    traces: u64,
    bytes: u64,
}

/// Batches on disk, each a zstd-packed JSON array named so that the oldest sorts first:
/// `<unix nanos>-<sequence>-<traces>.zst`.
struct Spool {
    dir: PathBuf,
    max_bytes: u64,
    batches: Vec<Spooled>,
    sequence: u64,
    dropped: u64,
}

impl Spool {
    fn open(dir: PathBuf, max_bytes: u64) -> std::io::Result<Self> {
        std::fs::create_dir_all(&dir)?;
        let mut batches = Vec::new();
        for entry in std::fs::read_dir(&dir)? {
            let path = entry?.path();
            match path.extension().and_then(|extension| extension.to_str()) {
                Some("zst") => {
                    if let Some(traces) = traces_in(&path) {
                        let bytes = std::fs::metadata(&path).map_or(0, |meta| meta.len());
                        batches.push(Spooled {
                            path,
                            traces,
                            bytes,
                        });
                    }
                }
                // A batch an agent was writing when it stopped.
                Some("tmp") => {
                    let _ = std::fs::remove_file(&path);
                }
                _ => {}
            }
        }
        batches.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(Self {
            dir,
            max_bytes,
            batches,
            sequence: 0,
            dropped: 0,
        })
    }

    fn is_empty(&self) -> bool {
        self.batches.is_empty()
    }

    fn traces(&self) -> u64 {
        self.batches.iter().map(|batch| batch.traces).sum()
    }

    fn oldest(&self) -> Option<Spooled> {
        self.batches.first().cloned()
    }

    fn push(&mut self, traces: &[Value]) -> std::io::Result<()> {
        let json = serde_json::to_vec(traces).map_err(std::io::Error::other)?;
        let packed = zstd::encode_all(&json[..], 3)?;
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |since| since.as_nanos());
        self.sequence += 1;
        let name = format!("{nanos:024}-{:010}-{}", self.sequence, traces.len());
        let path = self.dir.join(format!("{name}.zst"));
        // Written aside and renamed, so a batch is in the spool whole or not at all.
        let partial = self.dir.join(format!("{name}.tmp"));
        std::fs::write(&partial, &packed)?;
        std::fs::rename(&partial, &path)?;
        self.batches.push(Spooled {
            path,
            traces: traces.len() as u64,
            bytes: packed.len() as u64,
        });
        self.bound();
        Ok(())
    }

    /// Drop the oldest batches while the spool is over its size; the newest one always stays.
    fn bound(&mut self) {
        let mut total: u64 = self.batches.iter().map(|batch| batch.bytes).sum();
        while total > self.max_bytes && self.batches.len() > 1 {
            let oldest = self.batches.remove(0);
            total -= oldest.bytes;
            if self.dropped == 0 {
                eprintln!(
                    "tracepanel-agent: the cloud spool is full: the oldest traces are being dropped"
                );
            }
            self.dropped += oldest.traces;
            let _ = std::fs::remove_file(&oldest.path);
        }
    }

    fn remove(&mut self, batch: &Spooled) {
        let _ = std::fs::remove_file(&batch.path);
        self.batches.retain(|spooled| spooled.path != batch.path);
    }
}

/// How many traces a spooled batch holds, from its name.
fn traces_in(path: &Path) -> Option<u64> {
    path.file_stem()?.to_str()?.rsplit('-').next()?.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let pairs: Vec<(String, String)> = pairs
            .iter()
            .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
            .collect();
        move |name| {
            pairs
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.clone())
        }
    }

    #[test]
    fn no_key_no_sending() {
        assert_eq!(Config::from_env(env(&[])), Ok(None));
        assert_eq!(Config::from_env(env(&[("TRACEPANEL_KEY", " ")])), Ok(None));
    }

    #[test]
    fn a_key_sends_to_production_by_default() {
        assert_eq!(
            Config::from_env(env(&[("TRACEPANEL_KEY", "secret")])),
            Ok(Some(Config {
                key: "secret".into(),
                url: DEFAULT_URL.into(),
                environment: "production".into(),
            }))
        );
        assert_eq!(
            Config::from_env(env(&[
                ("TRACEPANEL_KEY", "secret"),
                ("TRACEPANEL_CLOUD_URL", "http://localhost:8102/"),
                ("TRACEPANEL_ENVIRONMENT", "staging-eu.1"),
            ])),
            Ok(Some(Config {
                key: "secret".into(),
                url: "http://localhost:8102".into(),
                environment: "staging-eu.1".into(),
            }))
        );
    }

    #[test]
    fn an_environment_a_url_could_not_carry_is_refused() {
        assert_eq!(
            Config::from_env(env(&[
                ("TRACEPANEL_KEY", "secret"),
                ("TRACEPANEL_ENVIRONMENT", "Prod EU"),
            ])),
            Err(
                "TRACEPANEL_ENVIRONMENT takes 1 to 64 of a-z, 0-9, '.', '_' and '-', not Prod EU"
                    .into()
            )
        );
        assert_eq!(
            Config::from_env(env(&[
                ("TRACEPANEL_KEY", "secret"),
                ("TRACEPANEL_CLOUD_URL", "ingest.example.com"),
            ])),
            Err("TRACEPANEL_CLOUD_URL takes an http(s) URL, not ingest.example.com".into())
        );
    }

    #[test]
    fn what_stays_local_is_stripped_and_the_environment_stamped() {
        let frame = |locals: Value| {
            json!({"filename": "blog/views.py", "module": "blog.views", "function": "post",
                   "lineno": 3, "in_app": true, "context_start": null, "context": [], "locals": locals})
        };
        let doc = json!({
            "id": "01K7B2Y7Q8M3E5R9T1V4W6X8Z0",
            "attrs": {"user.id": "42", "user.username": "ada", "user.email": "ada@example.com"},
            "spans": [
                {"attrs": {"db.statement": "SELECT 1 WHERE id = %s", "db.params": "[1]"}},
                {"attrs": {"mail.subject": "Hi", "mail.body": "secret", "mail.html": "<p>secret</p>"}}
            ],
            "logs": [{"attrs": {"code.function": "post", "extra.request": "<WSGIRequest>"}}],
            "errors": [{
                "frames": [frame(json!({"password": "'***'", "post": "<Post 1>"}))],
                "chain": [{"frames": [frame(json!({"x": "1"}))]}]
            }],
            "issues": [{"fingerprint": "5f2c9a8e1b7d4c3a"}]
        });

        let prepared = prepare(&doc.to_string(), "staging").unwrap();

        assert_eq!(
            prepared,
            json!({
                "id": "01K7B2Y7Q8M3E5R9T1V4W6X8Z0",
                "attrs": {"user.id": "42", "deployment.environment.name": "staging"},
                "spans": [
                    {"attrs": {"db.statement": "SELECT 1 WHERE id = %s"}},
                    {"attrs": {"mail.subject": "Hi"}}
                ],
                "logs": [{"attrs": {"code.function": "post"}}],
                "errors": [{
                    "frames": [frame(Value::Null)],
                    "chain": [{"frames": [frame(Value::Null)]}]
                }],
                "issues": [{"fingerprint": "5f2c9a8e1b7d4c3a"}]
            })
        );
    }

    #[test]
    fn a_trace_that_names_its_environment_keeps_it() {
        let doc = json!({"id": "x", "attrs": {"deployment.environment.name": "canary"}});

        let prepared = prepare(&doc.to_string(), "production").unwrap();

        assert_eq!(
            prepared,
            json!({"id": "x", "attrs": {"deployment.environment.name": "canary"}})
        );
    }

    #[test]
    fn a_recorded_trace_keeps_its_sql_and_loses_its_parameters() {
        let doc = include_str!("../../../schema/examples/python-django-async-n-plus-one.json");

        let prepared = prepare(doc, "production").unwrap();

        let spans = prepared["spans"].as_array().unwrap();
        let sql: Vec<&Value> = spans.iter().filter(|span| span["kind"] == "sql").collect();
        assert!(!sql.is_empty());
        for span in sql {
            let attrs = span["attrs"].as_object().unwrap();
            assert!(!attrs.contains_key("db.params"));
            assert!(attrs.contains_key("db.statement"));
            assert!(attrs.contains_key("db.params_hash"));
        }
    }

    #[test]
    fn what_is_not_a_trace_is_not_sent() {
        assert_eq!(prepare("not json", "production"), None);
        assert_eq!(prepare("[1, 2]", "production"), None);
    }
}
