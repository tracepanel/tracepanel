//! A trace's scope: the chain of calls under it (the traces other apps served for its calls, theirs in turn), on its
//! clock, and the part of it under one of its spans. The call tree opens the same chain; the trace's tabs (Logs) and
//! the MCP tools list what is in a scope and add it up.

use super::*;
use std::collections::HashSet;

/// The most traces down the chain, the trace itself being level 0: deeper calls are left out (as the call tree's).
pub const CHAIN_LEVELS: usize = 6;
/// The most traces in one chain.
pub const CHAIN_TRACES: usize = 60;
/// The most calls of one trace whose traces come into the chain (an N+1 of 36 calls to a service comes whole).
pub const CALL_TRACES: usize = 50;
/// The most records a scope lists.
pub const SCOPE_LOGS: usize = 5_000;
/// The slices of a scope's time its records are counted in, by level.
const HISTOGRAM_SLICES: usize = 24;

/// One trace of a chain: its document moved onto the first trace's clock (`shift`, µs), the trace above it (an index
/// in the chain) and the span of that trace whose call it served (`via`).
pub struct Member {
    pub doc: Value,
    pub parent: Option<usize>,
    pub via: Option<String>,
    pub level: usize,
    pub shift: i64,
    /// Another project's (its agent served it), by that project's name.
    pub project: Option<String>,
}

impl Member {
    pub fn id(&self) -> &str {
        self.doc["id"].as_str().unwrap_or_default()
    }

    /// The app that served it: its project's name, else its service.
    pub fn app(&self) -> &str {
        self.project
            .as_deref()
            .or_else(|| self.doc["attrs"]["service.name"].as_str())
            .unwrap_or_default()
    }

    fn spans(&self) -> impl Iterator<Item = &Value> {
        self.doc["spans"].as_array().into_iter().flatten()
    }

    fn span(&self, id: &str) -> Option<&Value> {
        self.spans().find(|span| span["id"] == id)
    }

    fn root(&self) -> Option<&str> {
        self.spans()
            .find(|span| span["parent_id"].is_null())
            .and_then(|span| span["id"].as_str())
    }
}

/// A trace and the traces under it down the chain of calls, the trace first; `capped` when a limit left some out.
pub struct Chain {
    pub members: Vec<Member>,
    pub capped: bool,
}

/// Other projects' traces for the calls of a trace no trace here answered: (the call's span id, the trace, the
/// project). Only the console asks other agents; elsewhere none.
pub type Remote<'a> = &'a dyn Fn(&str) -> Vec<(String, Value, String)>;

/// No other agents to ask.
pub fn no_remote(_: &str) -> Vec<(String, Value, String)> {
    Vec::new()
}

/// Where a span starts and ends.
fn extent(span: &Value) -> (i64, i64) {
    let start = span["start"].as_i64().unwrap_or_default();
    (start, start + span["duration"].as_i64().unwrap_or_default())
}

/// How far a call's trace moves to sit centred in the call: two apps' clocks disagree by a little, often more than
/// the way there and back takes (the call tree draws it the same).
fn shift_into(call: &Value, served: &Value) -> i64 {
    let (start, end) = extent(call);
    let duration = served["duration"].as_i64().unwrap_or_default();
    start + (end - start - duration).max(0) / 2 - served["start"].as_i64().unwrap_or_default()
}

/// A trace document with every time in it moved by `by` µs.
fn shifted(mut doc: Value, by: i64) -> Value {
    if by == 0 {
        return doc;
    }
    let move_key = |value: &mut Value, key: &str| {
        if let Some(time) = value[key].as_i64() {
            value[key] = Value::from(time + by);
        }
    };
    move_key(&mut doc, "start");
    for (list, key) in [("spans", "start"), ("logs", "time"), ("errors", "time")] {
        if let Some(items) = doc[list].as_array_mut() {
            for item in items {
                move_key(item, key);
            }
        }
    }
    doc
}

impl Reader {
    /// The calls of a trace another trace here served: (that trace's id, the span of this one that called), in the
    /// order they started.
    fn served_calls(&self, id: &str) -> rusqlite::Result<Vec<(String, String)>> {
        let db = self.connect()?;
        let mut statement = db.prepare(
            "SELECT l.trace_id, l.linked_span FROM links l JOIN traces t ON t.id = l.trace_id
             WHERE l.kind = 'called_by' AND l.linked_trace = ?1 ORDER BY t.start",
        )?;
        let rows = statement.query_map([id], |row| Ok((row.get(0)?, row.get(1)?)))?;
        rows.collect()
    }

    fn document(&self, id: &str) -> rusqlite::Result<Option<Value>> {
        Ok(self
            .get_trace(id)?
            .and_then(|doc| serde_json::from_str(&doc).ok()))
    }

    /// The trace, and with `whole` every trace down the chain of its calls (each on its call's clock, so on this
    /// trace's): level by level, up to `CHAIN_LEVELS` down, `CHAIN_TRACES` in all, a trace met twice once. None when
    /// the trace isn't stored.
    pub fn chain(&self, id: &str, whole: bool, remote: Remote) -> rusqlite::Result<Option<Chain>> {
        let Some(doc) = self.document(id)? else {
            return Ok(None);
        };
        let mut chain = Chain {
            members: vec![Member {
                doc,
                parent: None,
                via: None,
                level: 0,
                shift: 0,
                project: None,
            }],
            capped: false,
        };
        if !whole {
            return Ok(Some(chain));
        }
        let mut seen: HashSet<String> = HashSet::from([id.to_owned()]);
        let mut next = 0;
        while next < chain.members.len() {
            let at = next;
            next += 1;
            let member = &chain.members[at];
            // Another project's trace has no links here; the deepest level's calls stay out.
            if member.project.is_some() || member.level >= CHAIN_LEVELS {
                continue;
            }
            let (level, owner) = (member.level + 1, member.id().to_owned());
            let mut found: Vec<(String, Value, Option<String>)> = Vec::new();
            for (child, via) in self.served_calls(&owner)?.into_iter().take(CALL_TRACES) {
                if seen.contains(&child) {
                    continue;
                }
                if let Some(doc) = self.document(&child)? {
                    found.push((via, doc, None));
                }
            }
            for (via, doc, project) in remote(&owner) {
                found.push((via, doc, Some(project)));
            }
            for (via, doc, project) in found {
                let child = doc["id"].as_str().unwrap_or_default().to_owned();
                if !seen.insert(child) {
                    continue;
                }
                if chain.members.len() >= CHAIN_TRACES {
                    chain.capped = true;
                    break;
                }
                let shift = chain.members[at]
                    .span(&via)
                    .map_or(0, |call| shift_into(call, &doc));
                chain.members.push(Member {
                    doc: shifted(doc, shift),
                    parent: Some(at),
                    via: Some(via),
                    level,
                    shift,
                    project,
                });
            }
        }
        Ok(Some(chain))
    }
}

/// The part of a chain asked for: everything, or what is under some of its rows (`targets`: span ids, or a trace's
/// id for the whole of that trace), with `only` what is in those spans themselves, not in a span or trace under them.
#[derive(Default, Clone)]
pub struct Selection {
    pub targets: Vec<String>,
    pub only: bool,
}

/// What of one trace of the chain is in a scope.
#[derive(Clone, Debug, PartialEq)]
enum Part {
    Whole,
    /// These spans; a record logged in no span of the trace (a browser's console) counts when its time is in one of
    /// `windows` and in none of `outside`.
    Spans {
        ids: HashSet<String>,
        windows: Vec<(i64, i64)>,
        outside: Vec<(i64, i64)>,
    },
}

/// A chain, and what of each of its traces a selection takes.
pub struct Scope<'a> {
    pub chain: &'a Chain,
    parts: Vec<Option<Part>>,
    /// The time the selection covers, on the chain's clock: its spans' (none: the first trace's).
    pub window: (i64, i64),
}

/// A span's id and those of all the spans under it, in its trace.
fn subtree(member: &Member, top: &str) -> HashSet<String> {
    let mut ids = HashSet::from([top.to_owned()]);
    let mut grew = true;
    while grew {
        grew = false;
        for span in member.spans() {
            let (Some(id), Some(parent)) = (span["id"].as_str(), span["parent_id"].as_str()) else {
                continue;
            };
            if ids.contains(parent) && ids.insert(id.to_owned()) {
                grew = true;
            }
        }
    }
    ids
}

impl Chain {
    fn find(&self, target: &str) -> Option<(usize, Option<&Value>)> {
        self.members.iter().enumerate().find_map(|(at, member)| {
            if member.id() == target {
                return Some((at, None));
            }
            member.span(target).map(|span| (at, Some(span)))
        })
    }

    /// What of the chain a selection takes: with no targets every trace whole.
    pub fn select(&self, selection: &Selection) -> Scope<'_> {
        let root = &self.members[0].doc;
        let (start, end) = extent(root);
        if selection.targets.is_empty() {
            return Scope {
                chain: self,
                parts: vec![Some(Part::Whole); self.members.len()],
                window: (start, end),
            };
        }
        let mut parts: Vec<Option<Part>> = vec![None; self.members.len()];
        let mut windows: Vec<(i64, i64)> = Vec::new();
        for target in &selection.targets {
            let Some((at, span)) = self.find(target) else {
                continue;
            };
            let member = &self.members[at];
            // A trace asked for: all of it, or with `only` what its first span has of its own.
            let span = match span {
                Some(span) => span,
                None if selection.only => match member.root().and_then(|root| member.span(root)) {
                    Some(root) => root,
                    None => continue,
                },
                None => {
                    parts[at] = Some(Part::Whole);
                    windows.push(extent(&member.doc));
                    continue;
                }
            };
            let id = span["id"].as_str().unwrap_or_default();
            let window = extent(span);
            windows.push(window);
            let (ids, outside) = if selection.only {
                let children: Vec<(i64, i64)> = member
                    .spans()
                    .filter(|child| child["parent_id"] == id)
                    .map(extent)
                    .collect();
                (HashSet::from([id.to_owned()]), children)
            } else {
                (subtree(member, id), Vec::new())
            };
            add(&mut parts[at], ids, window, outside);
        }
        if !selection.only {
            // The traces served for calls under the spans taken, and theirs, whole; members come after their parent.
            for at in 1..self.members.len() {
                let member = &self.members[at];
                let (Some(parent), Some(via)) = (member.parent, member.via.as_deref()) else {
                    continue;
                };
                let under = match &parts[parent] {
                    Some(Part::Whole) => true,
                    Some(Part::Spans { ids, .. }) => ids.contains(via),
                    None => false,
                };
                if under {
                    parts[at] = Some(Part::Whole);
                }
            }
        }
        let window = if windows.is_empty() {
            (start, end)
        } else {
            (
                windows.iter().map(|w| w.0).min().unwrap_or(start),
                windows.iter().map(|w| w.1).max().unwrap_or(end),
            )
        };
        Scope {
            chain: self,
            parts,
            window,
        }
    }
}

fn add(part: &mut Option<Part>, more: HashSet<String>, window: (i64, i64), out: Vec<(i64, i64)>) {
    match part {
        Some(Part::Whole) => {}
        Some(Part::Spans {
            ids,
            windows,
            outside,
        }) => {
            ids.extend(more);
            windows.push(window);
            outside.extend(out);
        }
        None => {
            *part = Some(Part::Spans {
                ids: more,
                windows: vec![window],
                outside: out,
            });
        }
    }
}

fn within(time: i64, (start, end): (i64, i64)) -> bool {
    start <= time && time <= end
}

impl Scope<'_> {
    /// Whether a record of the chain's `at`th trace is in the scope: logged in a span taken, or, logged in no span
    /// of its trace, at a time in one.
    pub fn has_log(&self, at: usize, log: &Value) -> bool {
        match &self.parts[at] {
            None => false,
            Some(Part::Whole) => true,
            Some(Part::Spans {
                ids,
                windows,
                outside,
            }) => match log["span_id"].as_str() {
                Some(span) if self.chain.members[at].span(span).is_some() => ids.contains(span),
                _ => {
                    let time = log["time"].as_i64().unwrap_or_default();
                    windows.iter().any(|window| within(time, *window))
                        && !outside.iter().any(|window| within(time, *window))
                }
            },
        }
    }

    /// Whether a span of the chain's `at`th trace is in the scope.
    pub fn has_span(&self, at: usize, span: &str) -> bool {
        match &self.parts[at] {
            None => false,
            Some(Part::Whole) => true,
            Some(Part::Spans { ids, .. }) => ids.contains(span),
        }
    }

    /// The traces the scope takes any of, by their place in the chain.
    pub fn members(&self) -> impl Iterator<Item = (usize, &Member)> {
        self.chain
            .members
            .iter()
            .enumerate()
            .filter(|(at, _)| self.parts[*at].is_some())
    }

    /// The scope's records in time order (on the chain's clock), each with its trace and app; at most `SCOPE_LOGS`.
    pub fn logs(&self) -> Vec<Value> {
        let mut logs: Vec<Value> = self
            .members()
            .flat_map(|(at, member)| {
                member.doc["logs"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(move |log| self.has_log(at, log))
                    .map(move |log| {
                        let mut log = log.clone();
                        log["trace_id"] = Value::from(member.id());
                        log["app"] = Value::from(member.app());
                        log
                    })
            })
            .collect();
        logs.sort_by_key(|log| log["time"].as_i64().unwrap_or_default());
        logs.truncate(SCOPE_LOGS);
        logs
    }

    /// The traces of the chain, each with where it hangs: for the console to place them.
    pub fn traces(&self) -> Vec<Value> {
        self.chain
            .members
            .iter()
            .map(|member| {
                serde_json::json!({
                    "id": member.id(),
                    "app": member.app(),
                    "name": member.doc["name"],
                    "kind": member.doc["kind"],
                    "parent": member.parent.map(|at| self.chain.members[at].id()),
                    "via": member.via,
                    "level": member.level,
                    "shift": member.shift,
                })
            })
            .collect()
    }
}

/// Counts by a key, most first (ties by name).
fn counted<'a>(keys: impl Iterator<Item = &'a str>, name: &str) -> Value {
    let mut counts: HashMap<&str, i64> = HashMap::new();
    for key in keys {
        *counts.entry(key).or_default() += 1;
    }
    let mut rows: Vec<(&str, i64)> = counts.into_iter().collect();
    rows.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
    Value::Array(
        rows.into_iter()
            .map(|(key, count)| serde_json::json!({name: key, "count": count}))
            .collect(),
    )
}

fn is_error(level: &str) -> bool {
    matches!(level, "error" | "critical")
}

/// A scope's records added up: how many, by level, by app, by logger, its first error, and how many of each level
/// in each of `HISTOGRAM_SLICES` slices of `window`.
pub fn log_summary(logs: &[Value], window: (i64, i64)) -> Value {
    let level = |log: &Value| log["level"].as_str().unwrap_or_default().to_owned();
    let mut levels = serde_json::Map::new();
    for log in logs {
        let count = levels.entry(level(log)).or_insert(Value::from(0));
        *count = Value::from(count.as_i64().unwrap_or_default() + 1);
    }
    let first_error = logs
        .iter()
        .find(|log| is_error(&level(log)))
        .map(|log| {
            serde_json::json!({
                "time": log["time"], "level": log["level"], "logger": log["logger"], "message": log["message"],
                "app": log["app"], "trace_id": log["trace_id"], "span_id": log["span_id"],
            })
        })
        .unwrap_or(Value::Null);
    let times = logs.iter().filter_map(|log| log["time"].as_i64());
    let start = times
        .clone()
        .min()
        .map_or(window.0, |first| first.min(window.0));
    let end = times.max().map_or(window.1, |last| last.max(window.1));
    let width = (end - start).max(1) as f64 / HISTOGRAM_SLICES as f64;
    let mut slices = vec![serde_json::Map::new(); HISTOGRAM_SLICES];
    for log in logs {
        let time = log["time"].as_i64().unwrap_or(start);
        let at = (((time - start) as f64 / width) as usize).min(HISTOGRAM_SLICES - 1);
        let count = slices[at].entry(level(log)).or_insert(Value::from(0));
        *count = Value::from(count.as_i64().unwrap_or_default() + 1);
    }
    serde_json::json!({
        "total": logs.len(),
        "levels": levels,
        "apps": counted(logs.iter().map(|log| log["app"].as_str().unwrap_or_default()), "app"),
        "loggers": counted(logs.iter().map(|log| log["logger"].as_str().unwrap_or_default()), "logger"),
        "first_error": first_error,
        "histogram": {"start": start, "end": end, "slices": slices},
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const W3C: &str = "4bf92f3577b34da6a3ce929d0e0e4736";

    fn received(doc: Value) -> Received {
        Received {
            trace: serde_json::from_value(doc.clone()).unwrap(),
            doc: doc.to_string(),
        }
    }

    fn span(
        id: &str,
        parent: Option<&str>,
        kind: &str,
        name: &str,
        start: i64,
        duration: i64,
    ) -> Value {
        json!({"id": id, "parent_id": parent, "kind": kind, "name": name, "start": start, "duration": duration,
               "status": "ok", "attrs": {}})
    }

    fn log(span: Option<&str>, time: i64, level: &str, logger: &str, message: &str) -> Value {
        json!({"span_id": span, "time": time, "level": level, "logger": logger, "message": message,
               "exception": null, "attrs": {}})
    }

    fn trace(
        id: &str,
        app: &str,
        start: i64,
        duration: i64,
        parent: Option<&str>,
        spans: Vec<Value>,
        logs: Vec<Value>,
    ) -> Received {
        let mut attrs = json!({"service.name": app, "w3c.trace_id": W3C});
        if let Some(parent) = parent {
            attrs["w3c.parent_span_id"] = parent.into();
        }
        received(
            json!({"id": id, "kind": "http", "name": id, "start": start, "duration": duration, "status": "ok",
                        "attrs": attrs, "spans": spans, "logs": logs, "errors": [], "links": [], "issues": []}),
        )
    }

    /// A browser's view (its console line in no span) fetches the BFF, whose clock runs 4850 µs ahead; the BFF's
    /// three `Book.author` steps each call the service, whose traces log in their query.
    fn library(dir: &str) -> (PathBuf, Reader) {
        let dir =
            std::env::temp_dir().join(format!("tracepanel-scope-{dir}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = path_in(&dir);
        let mut store = Store::open(&path).unwrap();
        let mut fetch = span(
            "v-fetch",
            Some("v-root"),
            "http.client",
            "POST /graphql",
            100,
            800,
        );
        fetch["attrs"]["w3c.span_id"] = "f0".into();
        let view = trace(
            "VIEW",
            "library-web",
            0,
            1000,
            None,
            vec![span("v-root", None, "page", "VIEW /", 0, 1000), fetch],
            vec![
                log(None, 50, "info", "console", "loading"),
                log(None, 500, "warning", "console", "slow"),
            ],
        );
        let mut bff_spans = vec![span("b-root", None, "http", "POST /graphql", 5000, 700)];
        let mut api = Vec::new();
        for n in 1..=3 {
            let start = 5000 + 200 * n;
            bff_spans.push(span(
                &format!("b-r{n}"),
                Some("b-root"),
                "function",
                "Book.author",
                start,
                100,
            ));
            let mut call = span(
                &format!("b-c{n}"),
                Some(&format!("b-r{n}")),
                "http.client",
                "GET /authors/{id}",
                start + 10,
                80,
            );
            call["attrs"]["w3c.span_id"] = format!("c{n}").into();
            bff_spans.push(call);
            api.push(trace(
                &format!("API{n}"),
                "library-api",
                start + 20,
                60,
                Some(&format!("c{n}")),
                vec![
                    span(
                        &format!("a{n}-root"),
                        None,
                        "http",
                        "GET /authors/{id}",
                        start + 20,
                        60,
                    ),
                    span(
                        &format!("a{n}-sql"),
                        Some(&format!("a{n}-root")),
                        "sql",
                        "SELECT author",
                        start + 30,
                        10,
                    ),
                ],
                vec![log(
                    Some(&format!("a{n}-sql")),
                    start + 35,
                    if n == 2 { "error" } else { "info" },
                    "app.db",
                    &format!("author {n}"),
                )],
            ));
        }
        let bff = trace(
            "BFF",
            "library-bff",
            5000,
            700,
            Some("f0"),
            bff_spans,
            vec![
                log(Some("b-root"), 5010, "info", "yoga", "query Books"),
                log(Some("b-r1"), 5205, "debug", "resolvers", "author 1"),
            ],
        );
        store.write(&[view, bff]).unwrap();
        store.write(&api).unwrap();
        (dir, Reader::new(&path))
    }

    fn said(logs: &[Value]) -> Vec<(i64, String, String)> {
        logs.iter()
            .map(|log| {
                (
                    log["time"].as_i64().unwrap(),
                    log["app"].as_str().unwrap().into(),
                    log["message"].as_str().unwrap().into(),
                )
            })
            .collect()
    }

    fn selected(chain: &Chain, targets: &[&str], only: bool) -> Vec<(i64, String, String)> {
        let selection = Selection {
            targets: targets.iter().map(|t| (*t).into()).collect(),
            only,
        };
        said(&chain.select(&selection).logs())
    }

    fn row(time: i64, app: &str, message: &str) -> (i64, String, String) {
        (time, app.into(), message.into())
    }

    #[test]
    fn the_chain_is_every_trace_down_the_calls_on_the_first_ones_clock() {
        let (dir, reader) = library("chain");

        let chain = reader.chain("VIEW", true, &no_remote).unwrap().unwrap();
        let alone = reader.chain("VIEW", false, &no_remote).unwrap().unwrap();

        let placed: Vec<Value> = chain.select(&Selection::default()).traces();
        assert_eq!(
            placed,
            [
                json!({"id": "VIEW", "app": "library-web", "name": "VIEW", "kind": "http", "parent": null, "via": null, "level": 0, "shift": 0}),
                json!({"id": "BFF", "app": "library-bff", "name": "BFF", "kind": "http", "parent": "VIEW", "via": "v-fetch", "level": 1, "shift": -4850}),
                json!({"id": "API1", "app": "library-api", "name": "API1", "kind": "http", "parent": "BFF", "via": "b-c1", "level": 2, "shift": -4850}),
                json!({"id": "API2", "app": "library-api", "name": "API2", "kind": "http", "parent": "BFF", "via": "b-c2", "level": 2, "shift": -4850}),
                json!({"id": "API3", "app": "library-api", "name": "API3", "kind": "http", "parent": "BFF", "via": "b-c3", "level": 2, "shift": -4850}),
            ]
        );
        assert!(!chain.capped);

        assert_eq!(alone.members.len(), 1);
        assert!(reader.chain("NONE", true, &no_remote).unwrap().is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_whole_chain_logs_in_time_order_each_with_its_app() {
        let (dir, reader) = library("logs");
        let chain = reader.chain("VIEW", true, &no_remote).unwrap().unwrap();

        let all = selected(&chain, &[], false);

        assert_eq!(
            all,
            [
                row(50, "library-web", "loading"),
                row(160, "library-bff", "query Books"),
                row(355, "library-bff", "author 1"),
                row(385, "library-api", "author 1"),
                row(500, "library-web", "slow"),
                row(585, "library-api", "author 2"),
                row(785, "library-api", "author 3"),
            ]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn under_a_span_its_own_records_those_of_spans_under_it_and_of_the_traces_its_calls_reached() {
        let (dir, reader) = library("under");
        let chain = reader.chain("VIEW", true, &no_remote).unwrap().unwrap();

        let step = selected(&chain, &["b-r1"], false);
        let step_only = selected(&chain, &["b-r1"], true);
        let group = selected(&chain, &["b-r2", "b-r3"], false);
        let served = selected(&chain, &["API2"], false);
        let fetch = selected(&chain, &["v-fetch"], false);
        let view_only = selected(&chain, &["v-root"], true);

        assert_eq!(
            step,
            [
                row(355, "library-bff", "author 1"),
                row(385, "library-api", "author 1")
            ]
        );

        assert_eq!(step_only, [row(355, "library-bff", "author 1")]);

        assert_eq!(
            group,
            [
                row(585, "library-api", "author 2"),
                row(785, "library-api", "author 3")
            ]
        );

        assert_eq!(served, [row(585, "library-api", "author 2")]);

        // The browser's line in no span counts by its time: the fetch was on when it was logged.
        assert_eq!(fetch.len(), 6);
        assert_eq!(fetch[3], row(500, "library-web", "slow"));

        // Only the view's own: its line before the fetch, not the one while the fetch was on.
        assert_eq!(view_only, [row(50, "library-web", "loading")]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_scopes_records_add_up_by_level_app_logger_and_time() {
        let (dir, reader) = library("summary");
        let chain = reader.chain("VIEW", true, &no_remote).unwrap().unwrap();
        let scope = chain.select(&Selection {
            targets: vec!["b-root".into()],
            only: false,
        });

        let summary = log_summary(&scope.logs(), scope.window);

        let slices = summary["histogram"]["slices"].as_array().unwrap().clone();
        assert_eq!(
            json!({
                "total": summary["total"], "levels": summary["levels"], "apps": summary["apps"],
                "loggers": summary["loggers"], "first_error": summary["first_error"],
                "start": summary["histogram"]["start"], "end": summary["histogram"]["end"],
            }),
            json!({
                "total": 5,
                "levels": {"info": 3, "debug": 1, "error": 1},
                "apps": [{"app": "library-api", "count": 3}, {"app": "library-bff", "count": 2}],
                "loggers": [
                    {"logger": "app.db", "count": 3}, {"logger": "resolvers", "count": 1}, {"logger": "yoga", "count": 1},
                ],
                "first_error": {
                    "time": 585, "level": "error", "logger": "app.db", "message": "author 2", "app": "library-api",
                    "trace_id": "API2", "span_id": "a2-sql",
                },
                "start": 150, "end": 850,
            })
        );
        assert_eq!(slices.len(), 24);
        assert_eq!(slices[0], json!({"info": 1}));
        assert_eq!(
            slices
                .iter()
                .map(|slice| slice.as_object().unwrap().len())
                .sum::<usize>(),
            5
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
