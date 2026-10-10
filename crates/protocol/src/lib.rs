//! Receives and decodes events from the SDK.
//!
//! A connection starts with a hello line from the SDK, `{"protocol": 1, "max_traces": 2000, "thresholds": {...}}`,
//! answered with `{"ok": true}` or `{"ok": false, "error": "..."}`. Then frames: a 4-byte big-endian length and a JSON
//! array of traces (`schema/trace.schema.json`). The SDKs only record: the
//! agent finds the issues, with the SDK's thresholds.

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
#[derive(Clone, Default)]
pub struct Activity {
    last: Arc<std::sync::atomic::AtomicI64>,
    open: Arc<std::sync::atomic::AtomicUsize>,
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
                Ok(Received {
                    trace: serde_json::from_str(doc.get())?,
                    doc: doc.get().to_owned(),
                })
            })
            .collect()
    }
}

#[derive(Deserialize)]
struct Hello {
    protocol: u64,
    max_traces: Option<i64>,
    #[serde(default)]
    thresholds: Thresholds,
}

/// The limits issues are found with, as the SDK is configured (these defaults otherwise).
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(default)]
pub struct Thresholds {
    pub n_plus_one: i64,
    pub slow_sql_ms: i64,
    pub long_transaction_ms: i64,
}

impl Default for Thresholds {
    fn default() -> Self {
        Self {
            n_plus_one: 3,
            slow_sql_ms: 100,
            long_transaction_ms: 500,
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

async fn connection<S: AsyncRead + AsyncWrite + Unpin>(
    stream: S,
    sink: Sink,
    activity: &Activity,
) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream);
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
    reader
        .get_mut()
        .write_all(format!("{answer}\n").as_bytes())
        .await?;
    if refusal.is_some() {
        return Ok(());
    }
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
        sink(Batch {
            frame,
            max_traces: hello.max_traces,
            thresholds: hello.thresholds,
        });
    }
}
