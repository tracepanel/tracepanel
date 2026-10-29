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
    /// Another project's: how the call tree lists it under its call (`Served::row`).
    pub row: Option<Value>,
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

/// Another project's trace for a call of a trace no trace here answered.
pub struct Served {
    /// The call's span id.
    pub via: String,
    /// The trace.
    pub doc: Value,
    /// The project whose agent served it, by name.
    pub project: String,
    /// How the call tree lists it under the call (an entry of `remote_calls`): its summary, the call's span, that
    /// project and its console.
    pub row: Value,
}

/// Other projects' traces for the calls of a trace no trace here answered. Only the console asks other agents;
/// elsewhere none.
pub type Remote<'a> = &'a dyn Fn(&str) -> Vec<Served>;

/// A trace found for a call: the call's span id, the trace, and for another project's its name and row.
type Found = (String, Value, Option<(String, Value)>);

/// No other agents to ask.
pub fn no_remote(_: &str) -> Vec<Served> {
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
pub(crate) fn shifted(mut doc: Value, by: i64) -> Value {
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
                row: None,
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
            let mut found: Vec<Found> = Vec::new();
            for (child, via) in self.served_calls(&owner)?.into_iter().take(CALL_TRACES) {
                if seen.contains(&child) {
                    continue;
                }
                if let Some(doc) = self.document(&child)? {
                    found.push((via, doc, None));
                }
            }
            for served in remote(&owner) {
                found.push((served.via, served.doc, Some((served.project, served.row))));
            }
            for (via, doc, remote) in found {
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
                    project: remote.as_ref().map(|(project, _)| project.clone()),
                    row: remote.map(|(_, row)| row),
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

/// The N+1 a chain shows across apps: as many calls of one kind under one span as the analysis's N+1.
const CHAIN_REPEATS: usize = 3;

/// Issues by how much they cost a request: what failed first, then what repeats, then what is slow.
const ISSUE_ORDER: [&str; 13] = [
    "error",
    "n+1",
    "duplicates",
    "slow-sql",
    "slow-http",
    "slow-call",
    "long-transaction",
    "in-transaction",
    "blocking-call",
    "large-result",
    "queue-wait",
    "htmx",
    "migration-risk",
];

/// A member's trace as the analysis reads it.
fn parsed(member: &Member) -> Option<Trace> {
    serde_json::from_value(member.doc.clone()).ok()
}

/// The time spans cover together: overlapping ones counted once.
fn wall(mut ranges: Vec<(i64, i64)>) -> i64 {
    ranges.sort_unstable();
    let mut total = 0;
    let mut reach = i64::MIN;
    for (start, end) in ranges {
        if end <= reach {
            continue;
        }
        total += end - start.max(reach);
        reach = end;
    }
    total
}

impl Scope<'_> {
    /// The scope's calls of one family (`sql`, `http`, …), in time order, each its span with its trace, app and what
    /// it groups by (`key`, `template`, `target`, `op`).
    pub fn calls(&self, family: &str) -> Vec<Value> {
        let mut calls: Vec<Value> = self
            .members()
            .flat_map(|(at, member)| {
                let Some(trace) = parsed(member) else {
                    return Vec::new();
                };
                let docs: HashMap<&str, &Value> = member
                    .spans()
                    .filter_map(|span| Some((span["id"].as_str()?, span)))
                    .collect();
                trace
                    .spans
                    .iter()
                    .filter(|span| self.has_span(at, &span.id))
                    .filter_map(|span| {
                        let operation = tracepanel_analysis::calls::operation(&trace, span)?;
                        if operation.family != family {
                            return None;
                        }
                        let mut call = (*docs.get(span.id.as_str())?).clone();
                        call["trace_id"] = Value::from(member.id());
                        call["app"] = Value::from(member.app());
                        call["key"] = Value::from(call_key(&operation));
                        call["template"] = Value::from(operation.template);
                        call["target"] = Value::from(operation.target);
                        call["op"] = Value::from(operation.op);
                        Some(call)
                    })
                    .collect()
            })
            .collect();
        calls.sort_by_key(|call| call["start"].as_i64().unwrap_or_default());
        calls
    }

    /// The issues of the scope's traces, one per fingerprint (how many traces and times, which apps), with the
    /// chain's own N+1 across apps; the worst first. A trace taken whole brings all its issues, a part of one those on
    /// its spans.
    pub fn issues(&self) -> Vec<Value> {
        let mut found: Vec<(usize, Value)> = self
            .members()
            .flat_map(|(at, member)| {
                member.doc["issues"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(move |issue| (at, issue.clone()))
            })
            .chain(chain_issues(self.chain))
            .filter(|(at, issue)| {
                let spans = issue["span_ids"].as_array().cloned().unwrap_or_default();
                matches!(self.parts[*at], Some(Part::Whole))
                    || spans
                        .iter()
                        .filter_map(Value::as_str)
                        .any(|span| self.has_span(*at, span))
            })
            .collect();
        found.sort_by_key(|(at, _)| *at);
        let mut grouped: Vec<Value> = Vec::new();
        for (at, issue) in found {
            let member = &self.chain.members[at];
            let count = issue["count"].as_i64().unwrap_or(1).max(1);
            if let Some(group) = grouped
                .iter_mut()
                .find(|group| group["fingerprint"] == issue["fingerprint"])
            {
                group["traces"] = Value::from(group["traces"].as_i64().unwrap_or_default() + 1);
                group["occurrences"] =
                    Value::from(group["occurrences"].as_i64().unwrap_or_default() + count);
                if let Some(apps) = group["apps"].as_array_mut()
                    && !apps.iter().any(|app| app == member.app())
                {
                    apps.push(Value::from(member.app()));
                }
                continue;
            }
            let mut group = issue;
            group["trace_id"] = Value::from(member.id());
            group["app"] = Value::from(member.app());
            group["apps"] = serde_json::json!([member.app()]);
            group["traces"] = Value::from(1);
            group["occurrences"] = Value::from(count);
            grouped.push(group);
        }
        let rank = |issue: &Value| {
            ISSUE_ORDER
                .iter()
                .position(|kind| issue["kind"] == *kind)
                .unwrap_or(ISSUE_ORDER.len())
        };
        grouped.sort_by(|a, b| {
            rank(a)
                .cmp(&rank(b))
                .then(b["occurrences"].as_i64().cmp(&a["occurrences"].as_i64()))
        });
        grouped
    }
}

/// What a scope's calls add up to: how many, their time (in all, and on the clock: overlapping calls once), the
/// slowest, by app and by target (a database, a host), and each statement or endpoint they repeat with how many times
/// and in how many traces, the most first.
pub fn call_summary(calls: &[Value]) -> Value {
    let int = |call: &Value, key: &str| call[key].as_i64().unwrap_or_default();
    let total: i64 = calls.iter().map(|call| int(call, "duration")).sum();
    let ranges = calls
        .iter()
        .map(|call| {
            (
                int(call, "start"),
                int(call, "start") + int(call, "duration"),
            )
        })
        .collect();
    // The first of the slowest: `max_by_key` keeps the last of equals.
    let slowest = calls
        .iter()
        .rev()
        .max_by_key(|call| int(call, "duration"))
        .map(|call| {
            serde_json::json!({
                "name": call["name"], "duration": call["duration"], "app": call["app"],
                "trace_id": call["trace_id"], "span_id": call["id"],
            })
        })
        .unwrap_or(Value::Null);
    let mut groups: Vec<(String, Value, HashSet<String>)> = Vec::new();
    for call in calls {
        let key = call["key"].as_str().unwrap_or_default();
        let trace = call["trace_id"].as_str().unwrap_or_default().to_owned();
        match groups.iter_mut().find(|(each, ..)| each == key) {
            Some((_, group, traces)) => {
                group["count"] = Value::from(group["count"].as_i64().unwrap_or_default() + 1);
                group["total"] = Value::from(group["total"].as_i64().unwrap_or_default() + int(call, "duration"));
                traces.insert(trace);
            }
            None => groups.push((
                key.to_owned(),
                serde_json::json!({
                    "key": key, "template": call["template"], "op": call["op"], "target": call["target"],
                    "app": call["app"], "count": 1, "total": int(call, "duration"),
                }),
                HashSet::from([trace]),
            )),
        }
    }
    let mut groups: Vec<Value> = groups
        .into_iter()
        .map(|(_, mut group, traces)| {
            group["traces"] = Value::from(traces.len());
            group
        })
        .collect();
    groups.sort_by(|a, b| {
        b["count"]
            .as_i64()
            .cmp(&a["count"].as_i64())
            .then(b["total"].as_i64().cmp(&a["total"].as_i64()))
    });
    serde_json::json!({
        "count": calls.len(),
        "total": total,
        "wall": wall(ranges),
        "slowest": slowest,
        "apps": counted(calls.iter().map(|call| call["app"].as_str().unwrap_or_default()), "app"),
        "targets": counted(calls.iter().map(|call| call["target"].as_str().unwrap_or_default()), "target"),
        "groups": groups,
    })
}

/// What one call's trace ran: each SQL statement it ran (its key), with its span's name (`SELECT author`), its
/// database and how many times.
fn statements(member: &Member) -> HashMap<String, (String, String, i64)> {
    let mut found: HashMap<String, (String, String, i64)> = HashMap::new();
    let Some(trace) = parsed(member) else {
        return found;
    };
    for span in &trace.spans {
        let Some(operation) = tracepanel_analysis::calls::operation(&trace, span) else {
            continue;
        };
        if operation.family != "sql" {
            continue;
        }
        let entry = found.entry(call_key(&operation)).or_insert((
            span.name.clone(),
            operation.target.clone(),
            0,
        ));
        entry.2 += 1;
    }
    found
}

/// Where a call was made from: its GraphQL field (a resolver's step above it), else its line of code.
fn call_place(member: &Member, call: &Value) -> (Option<String>, Option<String>) {
    let parent = call["parent_id"].as_str().and_then(|id| member.span(id));
    let field = parent
        .and_then(|span| span["attrs"]["graphql.field"].as_str())
        .map(str::to_owned);
    let origin = call["attrs"]["code.origin"].as_str().map(str::to_owned);
    (field, origin)
}

/// The N+1 a chain has across apps: one span's repeated calls to another app (`Book.author`'s 36 `GET /authors/{id}`)
/// whose traces each run the same statement, so the service runs it once per item of the caller's list. Found when
/// the chain is read: the traces of one call arrive apart, and the issue is the caller's and the service's together.
/// Each is an issue of the calling trace, on its calls' spans, with the index of that trace in the chain.
pub fn chain_issues(chain: &Chain) -> Vec<(usize, Value)> {
    let mut issues = Vec::new();
    for (at, member) in chain.members.iter().enumerate() {
        // The traces served for this one's calls, by the call's parent span and what the call repeats.
        let mut repeats: HashMap<(String, String), Vec<(&Value, &Member)>> = HashMap::new();
        for child in chain
            .members
            .iter()
            .filter(|child| child.parent == Some(at))
        {
            let Some(call) = child.via.as_deref().and_then(|via| member.span(via)) else {
                continue;
            };
            // A resolver's calls (one `Book.author` step per book) repeat across its steps, not under one span.
            let step = call["parent_id"].as_str().and_then(|id| member.span(id));
            let parent = match step.and_then(|step| step["attrs"]["graphql.field"].as_str()) {
                Some(field) => format!(
                    "{field}@{}",
                    step.map_or("", |step| step["parent_id"].as_str().unwrap_or_default())
                ),
                None => call["parent_id"].as_str().unwrap_or_default().to_owned(),
            };
            let template = child.doc["attrs"]["http.route"]
                .as_str()
                .or_else(|| child.doc["name"].as_str())
                .unwrap_or_default()
                .to_owned();
            repeats
                .entry((parent, template))
                .or_default()
                .push((call, child));
        }
        let mut keys: Vec<&(String, String)> = repeats.keys().collect();
        keys.sort();
        for key in keys {
            let served = &repeats[key];
            if served.len() < CHAIN_REPEATS {
                continue;
            }
            let ran: Vec<HashMap<String, (String, String, i64)>> =
                served.iter().map(|(_, child)| statements(child)).collect();
            let mut counts: HashMap<&str, usize> = HashMap::new();
            for each in &ran {
                for statement in each.keys() {
                    *counts.entry(statement.as_str()).or_default() += 1;
                }
            }
            let mut repeated: Vec<(&str, usize)> = counts
                .into_iter()
                .filter(|(_, traces)| *traces >= CHAIN_REPEATS && *traces * 2 >= served.len())
                .collect();
            repeated.sort();
            for (statement, traces) in repeated {
                let (name, target, _) = ran
                    .iter()
                    .find_map(|each| each.get(statement))
                    .cloned()
                    .unwrap_or_default();
                let total: i64 = ran
                    .iter()
                    .filter_map(|each| each.get(statement).map(|(.., n)| *n))
                    .sum();
                let (call, child) = served[0];
                let (field, origin) = call_place(member, call);
                let app = child.app();
                let route = &key.1;
                let per = field.as_deref().map_or_else(
                    || format!("each `{route}` call"),
                    |field| format!("each `{field}`"),
                );
                let batch = field.as_deref().map_or_else(
                    || "Batch the calls into one".to_owned(),
                    |field| format!("Batch `{field}` (a DataLoader) into one call"),
                );
                issues.push((
                    at,
                    serde_json::json!({
                        "fingerprint": query_fingerprint(&format!("{}|{route}|{statement}", member.app()), "chain"),
                        "fingerprint_version": 1,
                        "kind": "n+1",
                        "title": format!("N+1 across apps: {total} similar queries in {app} · {name} · one per call from {per}"),
                        "culprit": field.or(origin),
                        "hint": format!(
                            "{} calls from {} to `{route}`, one per item, each run this query in {app} ({target}): \
                             {total} queries for one request. {batch}, and have {app} read the rows for all of \
                             them at once.",
                            served.len(), member.app(),
                        ),
                        "count": total,
                        "span_ids": served.iter().map(|(call, _)| call["id"].clone()).collect::<Vec<_>>(),
                        "chain": true,
                        "statement_traces": traces,
                    }),
                ));
            }
        }
    }
    issues
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
        if id.starts_with("API") {
            attrs["http.route"] = "/authors/{id}".into();
        }
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
            let mut step = span(
                &format!("b-r{n}"),
                Some("b-root"),
                "function",
                "Book.author",
                start,
                100,
            );
            step["attrs"]["graphql.field"] = "Book.author".into();
            bff_spans.push(step);
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

    #[test]
    fn a_scopes_queries_add_up_across_the_traces_of_the_chain() {
        let (dir, reader) = library("calls");
        let chain = reader.chain("VIEW", true, &no_remote).unwrap().unwrap();
        let whole = chain.select(&Selection::default());
        let step = chain.select(&Selection {
            targets: vec!["b-r1".into()],
            only: false,
        });

        let calls = whole.calls("sql");
        let summary = call_summary(&calls);
        let key = calls[0]["key"].clone();

        assert_eq!(
            calls
                .iter()
                .map(|call| (
                    call["id"].clone(),
                    call["app"].clone(),
                    call["trace_id"].clone()
                ))
                .collect::<Vec<_>>(),
            [
                (json!("a1-sql"), json!("library-api"), json!("API1")),
                (json!("a2-sql"), json!("library-api"), json!("API2")),
                (json!("a3-sql"), json!("library-api"), json!("API3")),
            ]
        );
        assert_eq!(
            summary,
            json!({
                "count": 3, "total": 30, "wall": 30,
                "slowest": {"name": "SELECT author", "duration": 10, "app": "library-api", "trace_id": "API1", "span_id": "a1-sql"},
                "apps": [{"app": "library-api", "count": 3}],
                "targets": [{"target": "default", "count": 3}],
                "groups": [{
                    "key": key, "template": "SELECT author", "op": "SELECT", "target": "default", "app": "library-api",
                    "count": 3, "total": 30, "traces": 3,
                }],
            })
        );

        assert_eq!(step.calls("sql").len(), 1);
        assert_eq!(whole.calls("http").len(), 4);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_query_each_of_a_steps_calls_runs_in_the_service_is_one_n_plus_one_across_apps() {
        let (dir, reader) = library("chain-n1");
        let chain = reader.chain("VIEW", true, &no_remote).unwrap().unwrap();

        let found = chain_issues(&chain);
        let whole = chain.select(&Selection::default()).issues();
        let step = chain
            .select(&Selection {
                targets: vec!["b-r2".into()],
                only: false,
            })
            .issues();
        let served = chain
            .select(&Selection {
                targets: vec!["API2".into()],
                only: false,
            })
            .issues();

        assert_eq!(found.len(), 1);
        let (at, issue) = &found[0];
        assert_eq!(*at, 1);
        assert_eq!(
            json!({
                "kind": issue["kind"], "title": issue["title"], "culprit": issue["culprit"], "hint": issue["hint"],
                "count": issue["count"], "span_ids": issue["span_ids"], "chain": issue["chain"],
            }),
            json!({
                "kind": "n+1",
                "title": "N+1 across apps: 3 similar queries in library-api · SELECT author · one per call from each `Book.author`",
                "culprit": "Book.author",
                "hint": "3 calls from library-bff to `/authors/{id}`, one per item, each run this query in library-api \
                         (default): 3 queries for one request. Batch `Book.author` (a DataLoader) into one call, and \
                         have library-api read the rows for all of them at once.",
                "count": 3,
                "span_ids": ["b-c1", "b-c2", "b-c3"],
                "chain": true,
            })
        );

        assert_eq!(
            whole
                .iter()
                .map(|issue| (
                    issue["title"].clone(),
                    issue["app"].clone(),
                    issue["traces"].clone()
                ))
                .collect::<Vec<_>>(),
            [(issue["title"].clone(), json!("library-bff"), json!(1))]
        );

        assert_eq!(step.len(), 1);

        assert_eq!(served, Vec::<Value>::new());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
