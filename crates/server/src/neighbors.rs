//! The agents of other projects on this machine: a call one project's app makes to another's is served by a trace in
//! the other project's store, which this agent can't read. Each agent with a console says where it is in the user's
//! cache (`agents/<pid>.json`: its store, its console, a token), and asks the others which of their traces served a
//! call of its own, by the W3C ids the call carried. A neighbour answers that only with its token: no page in a
//! browser and no other user of the machine can read the registry, so none can ask.

use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// How long a neighbour has to answer: the console's relations wait for it.
const ASK_TIMEOUT: Duration = Duration::from_millis(400);

/// This agent's entry in the registry, removed when it goes.
pub struct Registration {
    path: PathBuf,
}

impl Drop for Registration {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// A neighbour: its store, its console, and the token it answers with.
#[derive(Debug, Clone)]
pub struct Neighbour {
    pub dir: String,
    pub console: String,
    token: String,
}

/// The registry: TRACEPANEL_CACHE_DIR, else the user's cache (%LOCALAPPDATA%, $XDG_CACHE_HOME, ~/.cache), as the JVM
/// SDK keeps its agent download.
fn registry() -> Option<PathBuf> {
    let var = |name: &str| std::env::var(name).ok().filter(|value| !value.is_empty());
    let base = var("TRACEPANEL_CACHE_DIR")
        .map(PathBuf::from)
        .or_else(|| var("LOCALAPPDATA").map(|dir| Path::new(&dir).join("tracepanel")))
        .or_else(|| var("XDG_CACHE_HOME").map(|dir| Path::new(&dir).join("tracepanel")))
        .or_else(|| var("HOME").map(|home| Path::new(&home).join(".cache").join("tracepanel")))?;
    Some(base.join("agents"))
}

/// A token no one else guesses: from the system's random source, else from the process's random hasher seeds.
pub fn token() -> String {
    let mut bytes = [0u8; 16];
    let random = std::fs::File::open("/dev/urandom")
        .and_then(|mut source| std::io::Read::read_exact(&mut source, &mut bytes))
        .is_ok();
    if !random {
        use std::hash::{BuildHasher, Hasher};
        for chunk in bytes.chunks_mut(8) {
            let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH);
            hasher.write_u128(now.map_or(0, |since| since.as_nanos()));
            chunk.copy_from_slice(&hasher.finish().to_le_bytes());
        }
    }
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Says where this agent is: its store `dir`, its `console`, and the `token` it answers neighbours with.
pub fn register(dir: &Path, console: &str, token: &str) -> std::io::Result<Registration> {
    let registry = registry().ok_or_else(|| std::io::Error::other("no cache directory"))?;
    std::fs::create_dir_all(&registry)?;
    let path = registry.join(format!("{}.json", std::process::id()));
    let entry = json!({"pid": std::process::id(), "dir": dir, "console": console, "token": token});
    let partial = path.with_extension("part");
    std::fs::write(&partial, entry.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&partial, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(&partial, &path)?;
    Ok(Registration { path })
}

/// The other agents registered; one whose console doesn't answer has gone (killed, its entry left) and is dropped.
pub fn neighbours(own_console: &str) -> Vec<Neighbour> {
    let Some(registry) = registry() else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(&registry) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .path()
                .extension()
                .is_some_and(|extension| extension == "json")
        })
        .filter_map(|entry| {
            let text = std::fs::read_to_string(entry.path()).ok()?;
            let value: Value = serde_json::from_str(&text).ok()?;
            let neighbour = Neighbour {
                dir: value["dir"].as_str()?.to_owned(),
                console: value["console"].as_str()?.to_owned(),
                token: value["token"].as_str()?.to_owned(),
            };
            if neighbour.console == own_console {
                return None;
            }
            if !answers(&neighbour.console) {
                let _ = std::fs::remove_file(entry.path());
                return None;
            }
            Some(neighbour)
        })
        .collect()
}

/// Whether a console's port takes a connection: a gone agent's doesn't.
fn answers(console: &str) -> bool {
    let address = console.trim_start_matches("http://").trim_end_matches('/');
    address
        .parse()
        .is_ok_and(|address| std::net::TcpStream::connect_timeout(&address, ASK_TIMEOUT).is_ok())
}

/// The trace of `neighbour` that served the call with these W3C ids, with where its console is; none if it has none.
pub fn ask(neighbour: &Neighbour, w3c_trace: &str, w3c_span: &str) -> Option<Value> {
    let agent = ureq::Agent::config_builder()
        .timeout_global(Some(ASK_TIMEOUT))
        .http_status_as_error(false)
        .build()
        .new_agent();
    let url = format!(
        "{}api/w3c?trace={w3c_trace}&span={w3c_span}",
        neighbour.console
    );
    let mut response = agent
        .get(&url)
        .header("x-tracepanel-token", &neighbour.token)
        .call()
        .ok()?;
    if response.status() != 200 {
        return None;
    }
    let mut answer: Value = response.body_mut().read_json().ok()?;
    answer["console"] = Value::from(neighbour.console.clone());
    answer["project"] = Value::from(project(&neighbour.dir));
    Some(answer)
}

/// A project by its store's directory: the folder that holds `.tracepanel`.
fn project(dir: &str) -> String {
    let path = Path::new(dir);
    let folder = if path.file_name().is_some_and(|name| name == ".tracepanel") {
        path.parent().unwrap_or(path)
    } else {
        path
    };
    folder.file_name().map_or_else(
        || dir.to_owned(),
        |name| name.to_string_lossy().into_owned(),
    )
}
