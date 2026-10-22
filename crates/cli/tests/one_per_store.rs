//! One agent per store, however many start at the same moment: an app's workers, forked together, each start one.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const AGENTS: usize = 8;
/// The race is lost now and then: a few rounds of it.
const ROUNDS: usize = 5;
const WAIT: Duration = Duration::from_secs(10);

fn store(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("tracepanel-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn start(dir: &Path) -> Child {
    Command::new(env!("CARGO_BIN_EXE_tracepanel-agent"))
        .args(["--serve", "127.0.0.1:0", "--otlp", "off", "--dir"])
        .arg(dir)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap()
}

/// The address the agent wrote, once it answers there.
fn answering(dir: &Path) -> String {
    let deadline = Instant::now() + WAIT;
    while Instant::now() < deadline {
        let address = std::fs::read_to_string(dir.join("agent.addr")).unwrap_or_default();
        if tracepanel_answers(address.trim()) {
            return address.trim().to_owned();
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("no agent answers for {}", dir.display());
}

fn tracepanel_answers(address: &str) -> bool {
    #[cfg(unix)]
    if let Some(path) = address.strip_prefix("unix:") {
        return std::os::unix::net::UnixStream::connect(path).is_ok();
    }
    address
        .strip_prefix("tcp:")
        .is_some_and(|addr| std::net::TcpStream::connect(addr).is_ok())
}

fn stop(mut agent: Child) {
    #[cfg(unix)]
    {
        let _ = Command::new("kill").arg(agent.id().to_string()).status();
        let _ = agent.wait();
    }
    #[cfg(not(unix))]
    {
        let _ = agent.kill();
        let _ = agent.wait();
    }
}

#[test]
fn agents_started_together_leave_one_serving_the_store() {
    for round in 0..ROUNDS {
        together(&store(&format!("together-{round}")));
    }
}

fn together(dir: &Path) {
    let mut agents: Vec<Child> = (0..AGENTS).map(|_| start(dir)).collect();
    let address = answering(dir);

    // The others exit at once, saying why: the status tells the SDK that started one to connect to the winner.
    let deadline = Instant::now() + WAIT;
    let mut exited = Vec::new();
    while exited.len() < AGENTS - 1 && Instant::now() < deadline {
        let mut index = 0;
        while index < agents.len() {
            if agents[index].try_wait().unwrap().is_some() {
                let output = agents.remove(index).wait_with_output().unwrap();
                let said = String::from_utf8(output.stderr).unwrap();
                exited.push((output.status.code(), said));
            } else {
                index += 1;
            }
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let expected = format!(
        "tracepanel-agent: an agent already runs for {}\n",
        dir.canonicalize().unwrap().display()
    );
    assert_eq!(exited, vec![(Some(3), expected); AGENTS - 1]);
    assert_eq!(agents.len(), 1);

    // The one left is the one at the address, and it stays there.
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(answering(dir), address);
    assert!(agents[0].try_wait().unwrap().is_none());

    stop(agents.remove(0));
    let _ = std::fs::remove_dir_all(dir);
}

#[cfg(unix)]
#[test]
fn a_killed_agents_lock_is_free_for_the_next() {
    let dir = store("killed");
    let mut first = start(&dir);
    let gone = answering(&dir);
    // SIGKILL: no clean exit, its address files stay behind; the OS lets its lock go.
    first.kill().unwrap();
    first.wait().unwrap();
    assert!(dir.join("agent.addr").exists());

    let second = start(&dir);
    let address = answering(&dir);
    assert_eq!(address, gone);

    stop(second);
    assert!(!dir.join("agent.addr").exists());
    let _ = std::fs::remove_dir_all(&dir);
}
