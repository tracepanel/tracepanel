//! Where an agent takes OTLP: `TRACEPANEL_OTLP` from the environment an SDK starts it in, unless `--otlp` says
//! otherwise. It writes the address to `otlp.addr` while it serves there, and a port another project's agent holds is
//! named in the console's API with the address to use instead.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const WAIT: Duration = Duration::from_secs(10);

fn store(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("tracepanel-otlp-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir.canonicalize().unwrap()
}

/// A port nothing listens on, from the system; never 4318, which a developer's own agent may hold.
fn free_port() -> u16 {
    loop {
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        if port != 4318 {
            return port;
        }
    }
}

fn start(dir: &Path, cache: &Path, otlp_env: Option<&str>, flag: &[&str]) -> Child {
    let mut command = Command::new(env!("CARGO_BIN_EXE_tracepanel-agent"));
    command
        .args(["--serve", "127.0.0.1:0", "--dir"])
        .arg(dir)
        .args(flag)
        .env("TRACEPANEL_CACHE_DIR", cache)
        .env_remove("TRACEPANEL_API_KEY")
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    match otlp_env {
        Some(value) => command.env("TRACEPANEL_OTLP", value),
        None => command.env_remove("TRACEPANEL_OTLP"),
    };
    command.spawn().unwrap()
}

/// The console's address, once the agent has written its own (it writes `otlp.addr` before).
fn console(dir: &Path) -> String {
    let deadline = Instant::now() + WAIT;
    while Instant::now() < deadline {
        let agent = std::fs::read_to_string(dir.join("agent.addr")).unwrap_or_default();
        let console = std::fs::read_to_string(dir.join("console.addr")).unwrap_or_default();
        if !agent.trim().is_empty() && !console.trim().is_empty() {
            return console
                .trim()
                .trim_start_matches("http://")
                .trim_end_matches('/')
                .to_owned();
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("no agent started for {}", dir.display());
}

fn capabilities(console: &str) -> serde_json::Value {
    let mut stream = std::net::TcpStream::connect(console).unwrap();
    write!(
        stream,
        "GET /api/capabilities HTTP/1.1\r\nHost: {console}\r\nConnection: close\r\n\r\n"
    )
    .unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    let (_, body) = response.split_once("\r\n\r\n").unwrap();
    serde_json::from_str(body).unwrap()
}

/// What the agent has said on stderr by the time it says `expected`: it says why it takes no OTLP once it has
/// started.
fn said(agent: &mut Child, expected: &str) -> String {
    let mut stderr = agent.stderr.take().unwrap();
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut said = Vec::new();
        let mut chunk = [0u8; 1024];
        while let Ok(read) = stderr.read(&mut chunk) {
            if read == 0 {
                break;
            }
            said.extend_from_slice(&chunk[..read]);
            let _ = sender.send(String::from_utf8_lossy(&said).into_owned());
        }
    });
    let deadline = Instant::now() + WAIT;
    let mut text = String::new();
    while let Ok(next) = receiver.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
        text = next;
        if text.contains(expected) {
            break;
        }
    }
    text
}

/// Stops the agent as Ctrl-C would.
fn stop(mut agent: Child) {
    #[cfg(unix)]
    let _ = Command::new("kill").arg(agent.id().to_string()).status();
    #[cfg(not(unix))]
    let _ = agent.kill();
    let _ = agent.wait();
}

fn project(dir: &Path) -> String {
    dir.file_name().unwrap().to_string_lossy().into_owned()
}

#[test]
fn a_projects_own_otlp_port_from_its_environment_and_whose_a_taken_one_is() {
    let cache = store("cache");
    let (shop, blog) = (store("shop"), store("blog"));
    let port = free_port();
    let address = format!("127.0.0.1:{port}");

    let first = start(&shop, &cache, Some(&address), &[]);
    let shop_console = console(&shop);
    let mut second = start(&blog, &cache, Some(&address), &[]);
    let blog_console = console(&blog);

    assert_eq!(
        std::fs::read_to_string(shop.join("otlp.addr")).unwrap(),
        format!("http://{address}\n")
    );
    assert_eq!(
        capabilities(&shop_console)["otlp"],
        serde_json::json!({
            "address": address, "serving": true, "error": null, "taken": false, "taken_by": null, "free": null,
        })
    );

    // The second project's agent serves no OTLP there, and says whose it is and what to set instead.
    assert!(!blog.join("otlp.addr").exists());
    let taken = capabilities(&blog_console)["otlp"].clone();
    assert_eq!(taken["address"], address.as_str());
    assert_eq!(taken["serving"], false);
    assert_eq!(taken["taken"], true);
    assert_eq!(taken["taken_by"], project(&shop).as_str());
    let free = taken["free"].as_str().unwrap().to_owned();
    assert!(free.starts_with("127.0.0.1:"), "{taken}");
    assert_ne!(free, address);
    assert!(taken["error"].is_string());

    let line = format!(
        "no OTLP on {address}: it is taken by the agent of {}. Set TRACEPANEL_OTLP={free} for this project's apps",
        project(&shop)
    );
    let text = said(&mut second, &line);
    assert!(text.contains(&line), "{text}");
    stop(second);

    // Gone with its agent (stopped, not killed: Windows has no TERM).
    stop(first);
    #[cfg(unix)]
    assert!(!shop.join("otlp.addr").exists());

    let _ = std::fs::remove_dir_all(&cache);
    let _ = std::fs::remove_dir_all(&shop);
    let _ = std::fs::remove_dir_all(&blog);
}

#[test]
fn a_port_another_program_holds_is_taken_by_nobody_known() {
    let cache = store("cache-other");
    let dir = store("other");
    let holder = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = holder.local_addr().unwrap().to_string();

    let mut agent = start(&dir, &cache, None, &["--otlp", &address]);
    let taken = capabilities(&console(&dir))["otlp"].clone();

    assert!(!dir.join("otlp.addr").exists());
    assert_eq!(taken["serving"], false);
    assert_eq!(taken["taken"], true);
    assert_eq!(taken["taken_by"], serde_json::Value::Null);

    let line = format!("no OTLP on {address}: it is taken by another program.");
    let text = said(&mut agent, &line);
    assert!(text.contains(&line), "{text}");
    stop(agent);
    drop(holder);
    let _ = std::fs::remove_dir_all(&cache);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_flag_beats_the_environment() {
    let cache = store("cache-flag");
    let dir = store("flag");
    let address = format!("127.0.0.1:{}", free_port());

    let agent = start(&dir, &cache, Some(&address), &["--otlp", "off"]);
    let answer = capabilities(&console(&dir));

    assert!(!dir.join("otlp.addr").exists());
    assert_eq!(answer.get("otlp"), None);

    stop(agent);
    let _ = std::fs::remove_dir_all(&cache);
    let _ = std::fs::remove_dir_all(&dir);
}
