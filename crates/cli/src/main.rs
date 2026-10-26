//! `tracepanel-agent`: the project's agent. It receives the traces its processes record (an SDK in each: Python, Go)
//! over a unix socket (TCP on Windows, or with `--listen tcp:HOST:PORT`), finds their issues, keeps them in the
//! project's store and, with `--serve`, serves the console. OpenTelemetry exporters send it their spans over OTLP/HTTP
//! (`--otlp`, 127.0.0.1:4318 by default, where they send them unless told otherwise). Its addresses go to `<dir>/agent.addr` and
//! `<dir>/console.addr`, where the SDKs look for them. One agent serves a store: it holds `<dir>/agent.lock` while it
//! runs, and another started on the same store exits at once with status 3 (`ALREADY_RUNS`). With `TRACEPANEL_API_KEY` set, it also sends the traces it keeps
//! to Tracepanel Cloud (`tracepanel-sender`).

#[cfg(all(target_arch = "arm", target_env = "musl"))]
mod arm_eabi;

#[cfg(unix)]
use sha1::{Digest, Sha1};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, TrySendError, sync_channel};
use tracepanel_protocol::{Activity, Batch, Listener, Received};
use tracepanel_sender::Sender;
use tracepanel_store_local::{self as store_local, Store};

/// Frames waiting for the writer; a full queue drops frames rather than slowing the senders down.
const QUEUE: usize = 1024;

/// Frames dropped because the writer was behind: said once as it starts, counted at exit.
static DROPPED: AtomicU64 = AtomicU64::new(0);

const USAGE: &str = "usage: tracepanel-agent [--dir DIR] [--listen unix|tcp:HOST:PORT] [--serve HOST:PORT] \
                     [--otlp HOST:PORT|off] [--idle-exit SECONDS] [--record DIR] [--llm-prices FILE]
       tracepanel-agent mcp [--dir DIR] [--values]
  --dir        the project's store directory (default .tracepanel)
  --listen     where SDKs connect: a unix socket (default; not on Windows) or TCP, e.g. tcp:127.0.0.1:0
  --serve      also serve the console (UI and API), e.g. 127.0.0.1:8765 (port 0: any free one)
  --otlp       take OpenTelemetry exporters' spans over OTLP/HTTP here (default 127.0.0.1:4318; off: don't)
  --idle-exit  exit after this many seconds unused (an agent an SDK started)
  --record     also save each trace as received, before analysis, to DIR/<id>.json (schema/examples)
  --llm-prices the LLM prices to estimate costs with, over the built-in ones (default DIR/llm-prices.json, if any)
  --version    print the version

  mcp          an MCP server on stdin and stdout, for AI coding agents: reads the store, compact
  --values     with mcp: show SQL parameters and local variables (secrets masked); off by default";

enum Message {
    Batch(Batch),
    Stop,
}

/// The exit status of an agent started on a store another agent serves: the SDK that started it connects to that one.
const ALREADY_RUNS: u8 = 3;

/// The file an agent holds an exclusive lock on while it serves the store: the OS lets it go when the agent exits,
/// however it exits.
const LOCK_FILE: &str = "agent.lock";

/// Another agent serves the store.
#[derive(Debug)]
struct AlreadyRuns(PathBuf);

impl std::fmt::Display for AlreadyRuns {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "an agent already runs for {}", self.0.display())
    }
}

impl std::error::Error for AlreadyRuns {}

/// What the command line asks for.
#[derive(Debug, PartialEq)]
struct Options {
    dir: PathBuf,
    listen: Option<String>,
    serve: Option<String>,
    /// Where OTLP/HTTP is served; none with `--otlp off`.
    otlp: Option<String>,
    idle_exit: Option<i64>,
    record: Option<PathBuf>,
    /// The LLM prices over the built-in ones; none: the store's `llm-prices.json`, when there is one.
    llm_prices: Option<PathBuf>,
}

/// The file of LLM prices in the store's directory that overrides the built-in ones, when it is there.
const LLM_PRICES: &str = "llm-prices.json";

/// Where OpenTelemetry exporters send OTLP/HTTP unless told otherwise.
const OTLP_DEFAULT: &str = "127.0.0.1:4318";

/// What to do: run, or print something and exit.
#[derive(Debug, PartialEq)]
enum Command {
    Run(Options),
    /// The MCP server on the store in `dir`.
    Mcp {
        dir: PathBuf,
        values: bool,
    },
    Help,
    Version,
}

fn parse(args: impl IntoIterator<Item = String>) -> Result<Command, String> {
    let mut options = Options {
        dir: PathBuf::from(".tracepanel"),
        listen: None,
        serve: None,
        otlp: Some(OTLP_DEFAULT.into()),
        idle_exit: None,
        record: None,
        llm_prices: None,
    };
    let (mut mcp, mut values) = (false, false);
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        let mut value = |what: &str| args.next().ok_or_else(|| format!("{arg} needs {what}"));
        match arg.as_str() {
            "--help" | "-h" => return Ok(Command::Help),
            "mcp" => mcp = true,
            "--values" => values = true,
            "--version" | "-V" => return Ok(Command::Version),
            "--dir" => options.dir = PathBuf::from(value("a directory")?),
            "--serve" => options.serve = Some(value("HOST:PORT")?),
            "--record" => options.record = Some(PathBuf::from(value("a directory")?)),
            "--llm-prices" => options.llm_prices = Some(PathBuf::from(value("a file")?)),
            "--otlp" => {
                let otlp = value("HOST:PORT or off")?;
                options.otlp = (otlp != "off").then_some(otlp);
            }
            "--listen" => {
                let listen = value("unix or tcp:HOST:PORT")?;
                if listen != "unix" && !listen.starts_with("tcp:") {
                    return Err(format!(
                        "--listen takes unix or tcp:HOST:PORT, not {listen}"
                    ));
                }
                options.listen = Some(listen);
            }
            "--idle-exit" => {
                let seconds = value("a number of seconds")?;
                let seconds = seconds
                    .parse()
                    .ok()
                    .filter(|seconds: &i64| *seconds > 0)
                    .ok_or_else(|| {
                        format!("--idle-exit takes a number of seconds, not {seconds}")
                    })?;
                options.idle_exit = Some(seconds);
            }
            _ => return Err(format!("unknown option {arg}")),
        }
    }
    if mcp {
        let agent = options.listen.is_some()
            || options.serve.is_some()
            || options.idle_exit.is_some()
            || options.record.is_some()
            || options.llm_prices.is_some();
        if agent {
            return Err("mcp takes only --dir and --values".into());
        }
        return Ok(Command::Mcp {
            dir: options.dir,
            values,
        });
    }
    if values {
        return Err("--values goes with mcp".into());
    }
    Ok(Command::Run(options))
}

#[tokio::main]
async fn main() -> ExitCode {
    match parse(std::env::args().skip(1)) {
        Ok(Command::Help) => {
            println!("{USAGE}");
            ExitCode::SUCCESS
        }
        Ok(Command::Version) => {
            println!("tracepanel-agent {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        Ok(Command::Mcp { dir, values }) => {
            // stdout is the protocol's: nothing else is printed there.
            let server = tracepanel_mcp::Server::new(dir, values);
            match server.serve(tokio::io::stdin(), tokio::io::stdout()).await {
                Ok(()) => ExitCode::SUCCESS,
                Err(error) => {
                    eprintln!("tracepanel-agent mcp: {error}");
                    ExitCode::FAILURE
                }
            }
        }
        Ok(Command::Run(options)) => match run(options).await {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("tracepanel-agent: {error}");
                if error.is::<AlreadyRuns>() {
                    ExitCode::from(ALREADY_RUNS)
                } else {
                    ExitCode::FAILURE
                }
            }
        },
        Err(error) => {
            eprintln!("tracepanel-agent: {error}\n{USAGE}");
            ExitCode::from(2)
        }
    }
}

async fn run(options: Options) -> Result<(), Box<dyn std::error::Error>> {
    let Options {
        dir,
        listen,
        serve,
        otlp,
        idle_exit,
        record,
        llm_prices,
    } = options;
    let cloud = tracepanel_sender::Config::from_env(|name| std::env::var(name).ok())?;
    std::fs::create_dir_all(&dir)?;
    let dir = dir.canonicalize()?;
    // Before the store is opened or the socket bound: agents started at the same moment (an app's workers, each
    // starting one) would take each other's socket and address files, and one would be left with clients nobody sees.
    let _lock = lock(&dir)?;
    prices(&dir, llm_prices.as_deref())?;
    let store_path = store_local::path_in(&dir);
    let addr_file = dir.join("agent.addr");
    let console_file = dir.join("console.addr");
    let running = std::fs::read_to_string(&addr_file).unwrap_or_default();
    if tracepanel_protocol::answers(running.trim()) {
        // An agent from before the lock.
        return Err(AlreadyRuns(dir).into());
    }
    // The addresses of an agent that didn't exit cleanly (killed, a reboot): nobody answers there.
    let _ = std::fs::remove_file(&addr_file);
    let _ = std::fs::remove_file(&console_file);
    let store = Store::open(&store_path)?;
    let listener = bind(&dir, listen.as_deref()).await?;
    let address = listener.address()?;
    let activity = Activity::default();
    activity.touch();

    let (queue, frames) = sync_channel::<Message>(QUEUE);
    if let Some(record) = &record {
        std::fs::create_dir_all(record)?;
    }
    let cloud_line = cloud
        .as_ref()
        .map(|cloud| format!("{} ({})", cloud.url, cloud.environment));
    // Batches wait here while the cloud can't take them, for this agent or the next one.
    let sender = match cloud {
        Some(cloud) => Some(Sender::start(
            cloud,
            dir.join("cloud"),
            tracepanel_sender::Options::default(),
        )?),
        None => None,
    };
    // A migrate command's trace makes its app's unapplied migrations what they are after it.
    let about = activity.about.clone();
    let writer =
        std::thread::spawn(move || write(store, &frames, record.as_deref(), sender, &about));
    let sender = queue.clone();
    let sink = Arc::new(move |batch: Batch| enqueue(&sender, batch));

    let otlp = match otlp {
        Some(addr) => serve_otlp(&addr, sink.clone(), activity.clone()).await,
        None => None,
    };
    let server = tokio::spawn({
        let activity = activity.clone();
        let sink = sink.clone();
        async move { tracepanel_protocol::serve(listener, sink, activity).await }
    });
    // This agent's entry among its neighbours, while it serves a console: removed as it goes.
    let mut registration = None;
    let console = match serve {
        Some(addr) => {
            let listener = tokio::net::TcpListener::bind(&addr).await?;
            let reader = store_local::Reader::new(&store_path);
            let url = format!("http://{}/", listener.local_addr()?);
            // Where an app's own console (Django's /__tracepanel__/) sends its API calls.
            std::fs::write(&console_file, format!("{url}\n"))?;
            // Where the agents of other projects on this machine find it, to ask which of its traces served their
            // apps' calls.
            let token = tracepanel_server::neighbors::token();
            tracepanel_server::identify(token.clone(), url.clone());
            registration = tracepanel_server::neighbors::register(&dir, &url, &token).ok();
            Some((
                url,
                tokio::spawn(serve_console(
                    listener,
                    reader,
                    activity.clone(),
                    sink.clone(),
                )),
            ))
        }
        None => None,
    };
    std::fs::write(&addr_file, format!("{address}\n"))?;
    println!("tracepanel-agent {}", env!("CARGO_PKG_VERSION"));
    println!("  store    {}", store_path.display());
    println!("  traces   {address}");
    if let Some((url, _)) = &console {
        println!("  console  {url}");
    }
    if let Some((url, _)) = &otlp {
        println!("  otlp     {url}");
    }
    if let Some(cloud) = &cloud_line {
        println!("  cloud    {cloud}");
    }
    match idle_exit {
        Some(seconds) => println!("Ctrl-C stops it; it exits after {seconds} s unused"),
        None => println!("Ctrl-C stops it"),
    }

    tokio::select! {
        result = server => { result??; }
        () = stopped() => {}
        () = idle(&activity, idle_exit) => { println!("tracepanel-agent: idle, exiting"); }
    }
    if let Some((_, console)) = console {
        console.abort();
    }
    if let Some((_, otlp)) = otlp {
        otlp.abort();
    }
    // What was received gets written before exiting.
    let _ = queue.send(Message::Stop);
    let _ = writer.join();
    drop(registration);
    let _ = std::fs::remove_file(&addr_file);
    let _ = std::fs::remove_file(&console_file);
    if let Some(socket) = address.strip_prefix("unix:") {
        let _ = std::fs::remove_file(socket);
    }
    Ok(())
}

/// The store's lock, held until the agent exits; `AlreadyRuns` while another agent holds it. A file system without
/// locks (some network ones) is said and gone without.
fn lock(dir: &Path) -> Result<Option<std::fs::File>, Box<dyn std::error::Error>> {
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(dir.join(LOCK_FILE))?;
    match file.try_lock() {
        Ok(()) => Ok(Some(file)),
        Err(std::fs::TryLockError::WouldBlock) => Err(AlreadyRuns(dir.to_path_buf()).into()),
        Err(std::fs::TryLockError::Error(error))
            if error.kind() == std::io::ErrorKind::Unsupported =>
        {
            eprintln!(
                "tracepanel-agent: can't lock {}: {error}",
                dir.join(LOCK_FILE).display()
            );
            Ok(None)
        }
        Err(std::fs::TryLockError::Error(error)) => Err(error.into()),
    }
}

/// A short path in the temp directory, one per store directory: a unix socket's path is limited to ~100 bytes,
/// which a project's own directory may not leave room for.
#[cfg(unix)]
fn socket_path(dir: &Path) -> PathBuf {
    let digest = Sha1::digest(dir.as_os_str().as_encoded_bytes());
    let hex: String = digest
        .iter()
        .take(6)
        .map(|byte| format!("{byte:02x}"))
        .collect();
    std::env::temp_dir().join(format!("tracepanel-{hex}.sock"))
}

/// The listener SDKs connect to: `tcp:HOST:PORT`, else a unix socket where there are any, else TCP on a free port.
async fn bind(dir: &Path, listen: Option<&str>) -> std::io::Result<Listener> {
    if let Some(addr) = listen.and_then(|listen| listen.strip_prefix("tcp:")) {
        return Listener::tcp(addr).await;
    }
    #[cfg(unix)]
    {
        let socket = socket_path(dir);
        // A socket left by an agent that didn't exit cleanly.
        let _ = std::fs::remove_file(&socket);
        Listener::unix(&socket)
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
        Listener::tcp("127.0.0.1:0").await
    }
}

/// Resolves once nothing has used the agent for `seconds` (never without a limit): an agent an SDK started.
async fn idle(activity: &Activity, seconds: Option<i64>) {
    let Some(seconds) = seconds else {
        return std::future::pending().await;
    };
    let check = std::time::Duration::from_secs((seconds as u64 / 4).clamp(1, 30));
    loop {
        tokio::time::sleep(check).await;
        if activity.idle_seconds() >= seconds {
            return;
        }
    }
}

/// OTLP/HTTP on `addr`, into the same queue as the SDKs' traces. A port in use (a collector of the developer's own)
/// is said and skipped: the SDKs' traces matter more.
async fn serve_otlp(
    addr: &str,
    sink: tracepanel_protocol::Sink,
    activity: Activity,
) -> Option<(String, tokio::task::JoinHandle<std::io::Result<()>>)> {
    match tokio::net::TcpListener::bind(addr).await {
        Ok(listener) => {
            let url = format!("http://{}", listener.local_addr().ok()?);
            Some((
                url,
                tokio::spawn(tracepanel_otlp::serve(listener, sink, activity)),
            ))
        }
        Err(error) => {
            eprintln!("tracepanel-agent: no OTLP on {addr}: {error}");
            None
        }
    }
}

async fn serve_console(
    listener: tokio::net::TcpListener,
    reader: store_local::Reader,
    activity: Activity,
    sink: tracepanel_protocol::Sink,
) {
    // The console takes a page's browser traces too, on its own address (a dev server proxies it to the page).
    if let Err(error) = tracepanel_server::serve_on(listener, reader, activity, Some(sink)).await {
        eprintln!("tracepanel-agent: console stopped: {error}");
    }
}

fn enqueue(queue: &SyncSender<Message>, batch: Batch) {
    let full = matches!(
        queue.try_send(Message::Batch(batch)),
        Err(TrySendError::Full(_))
    );
    if full && DROPPED.fetch_add(1, Ordering::Relaxed) == 0 {
        eprintln!(
            "tracepanel-agent: the writer is behind: frames are being dropped (counted at exit)"
        );
    }
}

fn write(
    mut store: Store,
    frames: &Receiver<Message>,
    record: Option<&Path>,
    sender: Option<Sender>,
    about: &tracepanel_protocol::about::About,
) {
    let mut written: u64 = 0;
    while let Ok(message) = frames.recv() {
        let Message::Batch(batch) = message else {
            // Stop: drain what is queued, then exit.
            while let Ok(Message::Batch(batch)) = frames.try_recv() {
                written += write_batch(&mut store, &batch, record, sender.as_ref(), about);
            }
            break;
        };
        written += write_batch(&mut store, &batch, record, sender.as_ref(), about);
    }
    match DROPPED.load(Ordering::Relaxed) {
        0 => println!("tracepanel-agent: {written} traces written"),
        dropped => println!("tracepanel-agent: {written} traces written, {dropped} frames dropped"),
    }
    if let Some(sender) = sender {
        let report = sender.stop();
        println!(
            "tracepanel-agent: {} traces sent to the cloud, {} dropped, {} waiting to be sent",
            report.sent, report.dropped, report.spooled
        );
    }
}

fn write_batch(
    store: &mut Store,
    batch: &Batch,
    record: Option<&Path>,
    sender: Option<&Sender>,
    about: &tracepanel_protocol::about::About,
) -> u64 {
    if let Some(max_traces) = batch.max_traces {
        store.max_traces = max_traces;
    }
    match batch.decode() {
        Ok(mut traces) => {
            if let Some(record) = record {
                save(record, &traces);
            }
            for received in &mut traces {
                tracepanel_analysis::apply(received, &batch.thresholds);
            }
            // As kept here, issues and all; the sender strips what stays local.
            if let Some(sender) = sender {
                for received in &traces {
                    sender.offer(received.doc.clone());
                }
            }
            let written = write_traces(store, &traces);
            // Once stored: the console links the app's migrations to the trace.
            let now = tracepanel_protocol::live::now_us();
            for received in &traces {
                about.migrated(&received.trace, now);
            }
            written
        }
        Err(error) => {
            eprintln!("tracepanel-agent: undecodable frame: {error}");
            0
        }
    }
}

/// Traces as an SDK sent them (`--record`): what `schema/examples` is made of.
fn save(dir: &Path, traces: &[Received]) {
    for received in traces {
        let pretty = serde_json::from_str::<serde_json::Value>(&received.doc)
            .and_then(|doc| serde_json::to_string_pretty(&doc));
        let path = dir.join(format!("{}.json", received.trace.id));
        if let Err(error) = pretty
            .map_err(std::io::Error::other)
            .and_then(|text| std::fs::write(&path, text + "\n"))
        {
            eprintln!("tracepanel-agent: can't record {}: {error}", path.display());
        }
    }
}

fn write_traces(store: &mut Store, traces: &[Received]) -> u64 {
    match store.write(traces) {
        Ok(()) => traces.len() as u64,
        Err(error) => {
            eprintln!("tracepanel-agent: store write failed: {error}");
            0
        }
    }
}

#[cfg(unix)]
async fn stopped() {
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .expect("SIGTERM handler");
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = terminate.recv() => {}
    }
}

#[cfg(not(unix))]
async fn stopped() {
    let _ = tokio::signal::ctrl_c().await;
}

/// The LLM prices the costs are estimated with: the built-in ones, under the file asked for or the store's own.
fn prices(dir: &Path, asked: Option<&Path>) -> Result<(), String> {
    let path = asked.map_or_else(|| dir.join(LLM_PRICES), Path::to_owned);
    let table = match std::fs::read_to_string(&path) {
        Ok(table) => table,
        Err(error) if asked.is_some() => return Err(format!("{}: {error}", path.display())),
        Err(_) => return Ok(()),
    };
    tracepanel_analysis::llm::set_prices(&table)
        .map_err(|error| format!("{}: {error}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(line: &str) -> Vec<String> {
        line.split_whitespace().map(str::to_owned).collect()
    }

    #[test]
    fn the_command_line() {
        assert_eq!(
            parse(args(
                "--dir .tp --serve 127.0.0.1:0 --idle-exit 1800 --listen tcp:127.0.0.1:0 --otlp 0.0.0.0:4318"
            )),
            Ok(Command::Run(Options {
                dir: PathBuf::from(".tp"),
                listen: Some("tcp:127.0.0.1:0".into()),
                serve: Some("127.0.0.1:0".into()),
                otlp: Some("0.0.0.0:4318".into()),
                idle_exit: Some(1800),
                record: None,
                llm_prices: None,
            }))
        );
        assert_eq!(
            parse(args("")),
            Ok(Command::Run(Options {
                dir: PathBuf::from(".tracepanel"),
                listen: None,
                serve: None,
                otlp: Some("127.0.0.1:4318".into()),
                idle_exit: None,
                record: None,
                llm_prices: None,
            }))
        );
        assert_eq!(
            parse(args("--otlp off")),
            Ok(Command::Run(Options {
                dir: PathBuf::from(".tracepanel"),
                listen: None,
                serve: None,
                otlp: None,
                idle_exit: None,
                record: None,
                llm_prices: None,
            }))
        );
        assert_eq!(
            parse(args("--llm-prices prices.json")),
            Ok(Command::Run(Options {
                dir: PathBuf::from(".tracepanel"),
                listen: None,
                serve: None,
                otlp: Some("127.0.0.1:4318".into()),
                idle_exit: None,
                record: None,
                llm_prices: Some(PathBuf::from("prices.json")),
            }))
        );
        assert_eq!(parse(args("--help")), Ok(Command::Help));
        assert_eq!(parse(args("-V")), Ok(Command::Version));
        // tracepanel's CLI puts --dir first.
        assert_eq!(
            parse(args("--dir .tp mcp --values")),
            Ok(Command::Mcp {
                dir: PathBuf::from(".tp"),
                values: true,
            })
        );
        assert_eq!(
            parse(args("mcp")),
            Ok(Command::Mcp {
                dir: PathBuf::from(".tracepanel"),
                values: false,
            })
        );
    }

    #[test]
    fn mistakes_say_what_is_wrong() {
        assert_eq!(
            parse(args("--serve")),
            Err("--serve needs HOST:PORT".into())
        );
        assert_eq!(
            parse(args("--listen udp:1")),
            Err("--listen takes unix or tcp:HOST:PORT, not udp:1".into())
        );
        assert_eq!(
            parse(args("--idle-exit soon")),
            Err("--idle-exit takes a number of seconds, not soon".into())
        );
        assert_eq!(
            parse(args("--idle-exit 0")),
            Err("--idle-exit takes a number of seconds, not 0".into())
        );
        assert_eq!(
            parse(args("--colour")),
            Err("unknown option --colour".into())
        );
        assert_eq!(
            parse(args("mcp --serve 127.0.0.1:0")),
            Err("mcp takes only --dir and --values".into())
        );
        assert_eq!(
            parse(args("--values")),
            Err("--values goes with mcp".into())
        );
    }

    #[test]
    fn llm_prices_from_the_store_or_the_file_asked_for() {
        let dir = std::env::temp_dir().join(format!("tracepanel-prices-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let missing = dir.join("missing.json");

        // No file of the store's: the built-in prices.
        assert_eq!(prices(&dir, None), Ok(()));
        assert!(
            prices(&dir, Some(&missing))
                .unwrap_err()
                .starts_with(&missing.display().to_string())
        );

        std::fs::write(dir.join(LLM_PRICES), "{").unwrap();
        assert!(
            prices(&dir, None)
                .unwrap_err()
                .contains("llm-prices.json: not JSON")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
