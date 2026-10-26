//! Receives and decodes events from the SDK.
//!
//! A connection starts with a hello line from the SDK, `{"protocol": 1, "max_traces": 2000, "thresholds": {...}}`,
//! answered with `{"ok": true}` or `{"ok": false, "error": "..."}`. Then frames: a 4-byte big-endian length and a JSON
//! array of traces (`schema/trace.schema.json`). The SDKs only record: the
//! agent finds the issues, with the SDK's thresholds. A frame that is an object is not traces: an app's answer to a
//! request sent to it, task events (`{"tasks": [...]}`, see [`live`]), or what the app's checks found once they ran
//! (`{"app": {...}}`). The hello may tell about the app itself (`app`: its settings, versions and checks, see
//! [`about`]).

pub mod about;
pub mod live;
pub mod local;

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::{Map, Value};
#[cfg(unix)]
use std::path::Path;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
#[cfg(unix)]
use tokio::net::UnixListener;

/// When the agent was last used, and by how many SDK connections now: an agent started on demand exits once idle.
/// `apps` are the connected apps that do something for the console besides sending traces, `tasks` the tasks in
/// flight their task events tell of, `about` what each app said about itself.
#[derive(Clone, Default)]
pub struct Activity {
    last: Arc<std::sync::atomic::AtomicI64>,
    open: Arc<std::sync::atomic::AtomicUsize>,
    pub apps: Apps,
    pub tasks: live::LiveTasks,
    pub about: about::About,
}

/// The apps connected now that can do something for the console (EXPLAIN a query on their database: `explain`),
/// and the requests sent to them still waiting for their answer. A request goes down the connection the app sends
/// its traces on, as a frame; its answer comes back up it as a frame, an object where traces are a list.
#[derive(Clone, Default)]
pub struct Apps {
    inner: Arc<std::sync::Mutex<AppsInner>>,
}

#[derive(Default)]
struct AppsInner {
    next: u64,
    apps: Vec<App>,
    waiting: std::collections::HashMap<u64, tokio::sync::oneshot::Sender<Value>>,
}

struct App {
    connection: u64,
    service: String,
    capabilities: Vec<String>,
    /// What the app answers at its own console (under its prefix, on its origin), not down this connection: Python's
    /// and Java's EXPLAIN, Django's user switching. Offered only to a console reached through that app.
    console: Vec<String>,
    requests: tokio::sync::mpsc::UnboundedSender<Vec<u8>>,
}

impl Apps {
    /// Whether a connected app can do `capability`.
    pub fn can(&self, capability: &str) -> bool {
        let inner = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        inner
            .apps
            .iter()
            .any(|app| app.capabilities.iter().any(|can| can == capability))
    }

    /// Whether a connected app of `service` (any app with "") says `capability` in its hello.
    pub fn says(&self, capability: &str, service: &str) -> bool {
        let inner = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        inner.apps.iter().any(|app| {
            (service.is_empty() || app.service == service)
                && app.capabilities.iter().any(|can| can == capability)
        })
    }

    /// Whether the console can offer `capability`: an app does it down its connection (or records it in its traces),
    /// or the console is the one an app serves (`via`, its service) and that app answers it there.
    pub fn offers(&self, capability: &str, via: Option<&str>) -> bool {
        let inner = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        inner.apps.iter().any(|app| {
            app.capabilities.iter().any(|can| can == capability)
                || (via == Some(app.service.as_str())
                    && app.console.iter().any(|can| can == capability))
        })
    }

    /// `request` sent to the app of `service` that can do `capability` (the only one that can, when none is of that
    /// service), and its answer, within `timeout`.
    pub async fn ask(
        &self,
        service: &str,
        capability: &str,
        mut request: Value,
        timeout: std::time::Duration,
    ) -> Result<Value, String> {
        let (id, answer) = {
            let mut inner = self
                .inner
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let able: Vec<&App> = inner
                .apps
                .iter()
                .filter(|app| app.capabilities.iter().any(|can| can == capability))
                .collect();
            let app = able
                .iter()
                .find(|app| app.service == service)
                .or_else(|| (able.len() == 1).then(|| &able[0]))
                .ok_or_else(|| {
                    format!("No app of service {service} that can {capability} is connected.")
                })?;
            let requests = app.requests.clone();
            inner.next += 1;
            let id = inner.next;
            request["id"] = Value::from(id);
            let (sender, answer) = tokio::sync::oneshot::channel();
            inner.waiting.insert(id, sender);
            let body = request.to_string().into_bytes();
            let mut frame = (body.len() as u32).to_be_bytes().to_vec();
            frame.extend(body);
            if requests.send(frame).is_err() {
                inner.waiting.remove(&id);
                return Err("The app's connection closed.".into());
            }
            (id, answer)
        };
        match tokio::time::timeout(timeout, answer).await {
            Ok(Ok(answer)) => Ok(answer),
            _ => {
                let mut inner = self
                    .inner
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                inner.waiting.remove(&id);
                Err("The app didn't answer in time.".into())
            }
        }
    }

    fn register(
        &self,
        service: String,
        capabilities: Vec<String>,
        console: Vec<String>,
        requests: tokio::sync::mpsc::UnboundedSender<Vec<u8>>,
    ) -> u64 {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        inner.next += 1;
        let connection = inner.next;
        inner.apps.push(App {
            connection,
            service,
            capabilities,
            console,
            requests,
        });
        connection
    }

    fn unregister(&self, connection: u64) {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        inner.apps.retain(|app| app.connection != connection);
    }

    fn answered(&self, answer: Value) {
        let Some(id) = answer.get("answer").and_then(Value::as_u64) else {
            return;
        };
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(waiting) = inner.waiting.remove(&id) {
            let _ = waiting.send(answer);
        }
    }
}

impl Activity {
    fn now() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |since| since.as_secs() as i64)
    }

    pub fn touch(&self) {
        self.last
            .store(Self::now(), std::sync::atomic::Ordering::Relaxed);
    }

    fn opened(&self) {
        self.open.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.touch();
    }

    fn closed(&self) {
        self.open.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
        self.touch();
    }

    /// Seconds since the last use, or 0 while an SDK is connected.
    pub fn idle_seconds(&self) -> i64 {
        if self.open.load(std::sync::atomic::Ordering::Relaxed) > 0 {
            return 0;
        }
        Self::now() - self.last.load(std::sync::atomic::Ordering::Relaxed)
    }
}

/// Where frames go: the store writer's queue (it must not block).
pub type Sink = Arc<dyn Fn(Batch) + Send + Sync>;

pub const PROTOCOL: u64 = 1;
/// A frame larger than this is a broken peer, not a batch of traces.
const MAX_FRAME: usize = 64 << 20;

pub type Attrs = Map<String, Value>;

#[derive(Debug, Deserialize)]
pub struct Trace {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub start: i64,
    #[serde(default)]
    pub duration: i64,
    #[serde(default = "ok")]
    pub status: String,
    #[serde(default)]
    pub attrs: Attrs,
    #[serde(default)]
    pub spans: Vec<Span>,
    #[serde(default)]
    pub logs: Vec<Log>,
    #[serde(default)]
    pub errors: Vec<Value>,
    #[serde(default)]
    pub links: Vec<Link>,
    #[serde(default)]
    pub issues: Vec<Issue>,
}

#[derive(Debug, Deserialize)]
pub struct Span {
    pub id: String,
    #[serde(default)]
    pub parent_id: Option<String>,
    pub kind: String,
    pub name: String,
    pub start: i64,
    #[serde(default)]
    pub duration: i64,
    #[serde(default = "ok")]
    pub status: String,
    #[serde(default)]
    pub attrs: Attrs,
}

#[derive(Debug, Deserialize)]
pub struct Log {
    /// The span it was logged in; none outside every span.
    #[serde(default)]
    pub span_id: Option<String>,
    pub time: i64,
    pub level: String,
    pub logger: String,
    pub message: String,
    pub exception: Option<String>,
    #[serde(default)]
    pub attrs: Attrs,
}

#[derive(Debug, Deserialize)]
pub struct Link {
    pub kind: String,
    pub trace_id: String,
    pub span_id: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct Issue {
    pub fingerprint: String,
    pub fingerprint_version: i64,
    pub kind: String,
    pub title: String,
    pub culprit: Option<String>,
    pub hint: Option<String>,
    #[serde(default)]
    pub count: i64,
    #[serde(default)]
    pub span_ids: Vec<String>,
}

fn ok() -> String {
    "ok".into()
}

/// One trace as received: decoded, and its JSON as sent (stored as the trace's document, unchanged).
pub struct Received {
    pub trace: Trace,
    pub doc: String,
}

/// A frame's traces; `max_traces` is the store size the sending process is configured with.
pub struct Batch {
    pub frame: Vec<u8>,
    pub max_traces: Option<i64>,
    /// The SDK's limits for finding issues.
    pub thresholds: Thresholds,
}

impl Batch {
    pub fn decode(&self) -> serde_json::Result<Vec<Received>> {
        let docs: Vec<&RawValue> = serde_json::from_slice(&self.frame)?;
        docs.into_iter()
            .map(|doc| {
                let trace: Trace = serde_json::from_str(doc.get())?;
                if trace.spans.len() <= MAX_SPANS && trace.logs.len() <= MAX_LOGS {
                    return Ok(Received {
                        trace,
                        doc: doc.get().to_owned(),
                    });
                }
                limited(doc.get())
            })
            .collect()
    }
}

/// The most spans a trace is stored with; the rest are counted (`tracepanel.dropped_spans`). Whatever sent it (an SDK
/// without a limit of its own, OpenTelemetry), one runaway trace can't fill the store or the console.
pub const MAX_SPANS: usize = 2000;
/// The most log records a trace is stored with; the rest are counted (`tracepanel.dropped_logs`).
pub const MAX_LOGS: usize = 1000;

/// A trace over the limits, cut down to them: its earliest spans (a parent starts before its children, so every span
/// kept keeps its parent) with its roots always, its first records, and how many went in its attrs.
fn limited(text: &str) -> serde_json::Result<Received> {
    let mut doc: Value = serde_json::from_str(text)?;
    let spans = cut(&mut doc, "spans", MAX_SPANS, |span| {
        let root = span.get("parent_id").is_none_or(Value::is_null);
        (
            !root,
            span.get("start").and_then(Value::as_i64).unwrap_or(0),
        )
    });
    let logs = cut(&mut doc, "logs", MAX_LOGS, |log| {
        (false, log.get("time").and_then(Value::as_i64).unwrap_or(0))
    });
    if let Some(attrs) = doc.get_mut("attrs").and_then(Value::as_object_mut) {
        for (key, dropped) in [
            ("tracepanel.dropped_spans", spans),
            ("tracepanel.dropped_logs", logs),
        ] {
            let before = attrs.get(key).and_then(Value::as_u64).unwrap_or(0);
            if dropped > 0 {
                attrs.insert(key.to_owned(), Value::from(before + dropped as u64));
            }
        }
    }
    Ok(Received {
        trace: serde_json::from_value(doc.clone())?,
        doc: doc.to_string(),
    })
}

/// The list at `key` cut to `limit` items, the ones `order` puts first kept in their own order; how many went.
fn cut(doc: &mut Value, key: &str, limit: usize, order: impl Fn(&Value) -> (bool, i64)) -> usize {
    let Some(items) = doc.get_mut(key).and_then(Value::as_array_mut) else {
        return 0;
    };
    if items.len() <= limit {
        return 0;
    }
    let mut ranked: Vec<usize> = (0..items.len()).collect();
    ranked.sort_by_key(|index| order(&items[*index]));
    let mut kept: Vec<usize> = ranked.into_iter().take(limit).collect();
    kept.sort_unstable();
    let dropped = items.len() - kept.len();
    let all = std::mem::take(items);
    *items = kept.into_iter().map(|index| all[index].clone()).collect();
    dropped
}

#[derive(Deserialize)]
struct Hello {
    protocol: u64,
    max_traces: Option<i64>,
    #[serde(default)]
    thresholds: Thresholds,
    /// The app's service.name and what it can do for the console (`explain`): SDKs from before send neither.
    #[serde(default)]
    service: String,
    #[serde(default)]
    capabilities: Vec<String>,
    /// What the app answers at its own console rather than down this connection (see `App::console`).
    #[serde(default)]
    console: Vec<String>,
    /// The app about itself (`settings`, `versions`, `checks`, `migrations`), once per connection: SDKs from before
    /// send none.
    #[serde(default)]
    app: Option<Value>,
}

/// The limits issues are found with, as the SDK is configured (these defaults otherwise).
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(default)]
pub struct Thresholds {
    pub n_plus_one: i64,
    pub slow_sql_ms: i64,
    pub long_transaction_ms: i64,
    /// An outgoing HTTP call this slow is an issue (SDKs from before it send none: the default then).
    pub slow_http_ms: i64,
    /// Repeated Redis commands or cache operations are an issue only when they cost this much together: an
    /// in-memory store answers in a fraction of a millisecond, and a few of those are nothing to fix.
    pub n_plus_one_min_ms: i64,
    /// A task that waited this long in its queue for a worker is an issue (SDKs from before it send none).
    pub queue_wait_ms: i64,
    /// A SELECT without a LIMIT that returned this many rows is an issue (SDKs from before it send none).
    pub large_result_rows: i64,
}

impl Default for Thresholds {
    fn default() -> Self {
        Self {
            n_plus_one: 3,
            slow_sql_ms: 100,
            long_transaction_ms: 500,
            slow_http_ms: 500,
            n_plus_one_min_ms: 5,
            queue_wait_ms: 1000,
            large_result_rows: 1000,
        }
    }
}

/// Where SDKs connect: a unix socket (the default where there are any), or TCP (Windows; an app in a container).
pub enum Listener {
    #[cfg(unix)]
    Unix(UnixListener, std::path::PathBuf),
    Tcp(TcpListener),
}

impl Listener {
    #[cfg(unix)]
    pub fn unix(socket: &Path) -> std::io::Result<Self> {
        Ok(Self::Unix(
            UnixListener::bind(socket)?,
            socket.to_path_buf(),
        ))
    }

    pub async fn tcp(addr: &str) -> std::io::Result<Self> {
        Ok(Self::Tcp(TcpListener::bind(addr).await?))
    }

    /// The address SDKs find in `agent.addr`: `unix:/path` or `tcp:host:port`.
    pub fn address(&self) -> std::io::Result<String> {
        match self {
            #[cfg(unix)]
            Self::Unix(_, path) => Ok(format!("unix:{}", path.display())),
            Self::Tcp(listener) => Ok(format!("tcp:{}", listener.local_addr()?)),
        }
    }
}

/// Is an agent answering at this address (`unix:/path`, `tcp:host:port`)?
pub fn answers(address: &str) -> bool {
    if let Some(addr) = address.strip_prefix("tcp:") {
        return std::net::TcpStream::connect(addr).is_ok();
    }
    #[cfg(unix)]
    if let Some(path) = address.strip_prefix("unix:") {
        return std::os::unix::net::UnixStream::connect(path).is_ok();
    }
    false
}

/// Accept SDK connections and pass every frame to `sink`.
pub async fn serve(listener: Listener, sink: Sink, activity: Activity) -> std::io::Result<()> {
    loop {
        match &listener {
            #[cfg(unix)]
            Listener::Unix(listener, _) => {
                let (stream, _) = listener.accept().await?;
                spawn(stream, sink.clone(), activity.clone());
            }
            Listener::Tcp(listener) => {
                let (stream, _) = listener.accept().await?;
                // Frames go one after another: no waiting to fill packets.
                stream.set_nodelay(true)?;
                spawn(stream, sink.clone(), activity.clone());
            }
        }
    }
}

fn spawn<S>(stream: S, sink: Sink, activity: Activity)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    activity.opened();
    tokio::spawn(async move {
        if let Err(error) = connection(stream, sink, &activity).await {
            eprintln!("tracepanel-agent: connection closed: {error}");
        }
        activity.closed();
    });
}

async fn connection<S: AsyncRead + AsyncWrite + Unpin + Send + 'static>(
    stream: S,
    sink: Sink,
    activity: &Activity,
) -> std::io::Result<()> {
    let (read, mut write) = tokio::io::split(stream);
    let mut reader = BufReader::new(read);
    let mut line = String::new();
    if reader.read_line(&mut line).await? == 0 {
        return Ok(());
    }
    let hello: Hello = serde_json::from_str(&line).map_err(std::io::Error::other)?;
    let refusal = (hello.protocol != PROTOCOL)
        .then(|| format!("protocol {} expected, got {}", PROTOCOL, hello.protocol));
    let answer = match &refusal {
        None => serde_json::json!({"ok": true}),
        Some(error) => serde_json::json!({"ok": false, "error": error}),
    };
    write.write_all(format!("{answer}\n").as_bytes()).await?;
    if refusal.is_some() {
        return Ok(());
    }
    let said = live::now_us();
    activity
        .about
        .hello(&hello.service, hello.app.as_ref(), said);
    // An app that can do something for the console takes requests down this connection, one frame each.
    let registered = (!(hello.capabilities.is_empty() && hello.console.is_empty())).then(|| {
        let (requests, mut queue) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
        tokio::spawn(async move {
            while let Some(frame) = queue.recv().await {
                if write.write_all(&frame).await.is_err() {
                    return;
                }
            }
        });
        activity.apps.register(
            hello.service.clone(),
            hello.capabilities.clone(),
            hello.console.clone(),
            requests,
        )
    });
    let result = frames(&mut reader, &sink, activity, &hello, said).await;
    if let Some(connection) = registered {
        activity.apps.unregister(connection);
    }
    activity.about.left(&hello.service);
    result
}

/// Frames until the app goes: lists of traces for the sink; objects with task events, or answering the requests
/// sent to it.
async fn frames<R: AsyncRead + Unpin>(
    reader: &mut BufReader<R>,
    sink: &Sink,
    activity: &Activity,
    hello: &Hello,
    said: i64,
) -> std::io::Result<()> {
    loop {
        let mut length = [0u8; 4];
        match reader.read_exact(&mut length).await {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(()),
            Err(error) => return Err(error),
        }
        let length = u32::from_be_bytes(length) as usize;
        if length > MAX_FRAME {
            return Err(std::io::Error::other(format!("frame of {length} bytes")));
        }
        let mut frame = vec![0u8; length];
        reader.read_exact(&mut frame).await?;
        activity.touch();
        if frame.first() == Some(&b'{') {
            if let Ok(object) = serde_json::from_slice::<Value>(&frame) {
                if let Some(events) = live::LiveTasks::events(&object) {
                    activity.tasks.take(events, &hello.service, live::now_us());
                } else if let Some(app) = object.get("app").filter(|app| app.is_object()) {
                    // What the app's checks found, after its hello.
                    activity
                        .about
                        .checked(&hello.service, app, said, live::now_us());
                } else {
                    activity.apps.answered(object);
                }
            }
            continue;
        }
        sink(Batch {
            frame,
            max_traces: hello.max_traces,
            thresholds: hello.thresholds,
        });
    }
}
