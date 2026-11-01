//! Who waited, in a CPU profile (Go's, Node's): its time off the CPU has no stack, but the trace's calls out (a
//! query, an HTTP call) say where the app made each (`code.origin`) and when. Each call's time is waiting under the
//! function of the app's that made it, as a Python or a JVM profile has its waits under the function that waited;
//! the console's Profile tab reads it the same way.

use crate::compact::{int, text};
use serde_json::Value;
use std::collections::HashMap;

/// The kinds of a call out of the app, as the console's call tree groups them: every system's, and the generic
/// families' (`db`, `messaging`, `rpc`).
const CALLS: [&str; 18] = [
    "sql",
    "redis",
    "cache",
    "mongodb",
    "elasticsearch",
    "cassandra",
    "dynamodb",
    "memcached",
    "kafka",
    "rabbitmq",
    "sqs",
    "grpc",
    "http.client",
    "storage",
    "llm",
    "db",
    "messaging",
    "rpc",
];

/// A profile's frame as a call's origin is matched to it.
pub(crate) struct Place<'a> {
    pub(crate) function: &'a str,
    pub(crate) file: &'a str,
    pub(crate) line: i64,
    pub(crate) in_app: bool,
}

/// `lib/catalog.ts:31 in card`, as every SDK writes code.origin: the file, the line, the function.
fn origin(span: &Value) -> Option<(&str, i64, &str)> {
    let value = span.get("attrs")?.get("code.origin")?.as_str()?;
    let (place, function) = value.split_once(" in ")?;
    let (file, line) = place.rsplit_once(':')?;
    Some((file, line.parse().ok()?, function))
}

/// The same file, however much of its path each names: `catalog.go` and `shop/catalog.go`.
fn same_file(a: &str, b: &str) -> bool {
    let (long, short) = if a.len() > b.len() { (a, b) } else { (b, a) };
    long == short || long.ends_with(&format!("/{short}"))
}

/// The same function, however each names it: `card`, `Catalog.card`, `(*App).listProducts`.
fn same_name(a: &str, b: &str) -> bool {
    a == b || a.rsplit('.').next() == b.rsplit('.').next()
}

/// The frame of the app's an origin names: in its file, the function it names, else the function its line is in
/// (the one starting last before it).
fn frame_of(frames: &[Place], (file, line, function): (&str, i64, &str)) -> Option<usize> {
    let in_file: Vec<usize> = (0..frames.len())
        .filter(|&index| frames[index].in_app && same_file(frames[index].file, file))
        .collect();
    in_file
        .iter()
        .copied()
        .find(|&index| same_name(frames[index].function, function))
        .or_else(|| {
            in_file
                .iter()
                .copied()
                .filter(|&index| frames[index].line <= line)
                .max_by_key(|&index| frames[index].line)
        })
}

/// The stack down to a frame, outermost first, the frame last: as the stacks reached it through most of the app's
/// functions (an async function's stack after an await starts at it), then most often.
fn path_to(frames: &[Place], stacks: &[(&[usize], i64)], index: usize) -> Option<Vec<usize>> {
    stacks
        .iter()
        .filter_map(|&(stack, count)| {
            let at = stack.iter().position(|&each| each == index)?;
            let path = stack[..=at].to_vec();
            let yours = path
                .iter()
                .filter(|&&each| frames.get(each).is_some_and(|frame| frame.in_app))
                .count();
            Some((yours, count, path))
        })
        .max_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)))
        .map(|(_, _, path)| path)
}

/// Each call's stretch of the trace (µs since it started) and the stack that waited for it: the function its
/// origin names, else its callers' nearest one's.
fn calls(doc: &Value, frames: &[Place], stacks: &[(&[usize], i64)]) -> Vec<(i64, i64, Vec<usize>)> {
    let spans: Vec<&Value> = doc
        .get("spans")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .collect();
    let by_id: HashMap<&str, &Value> = spans.iter().map(|span| (text(span, "id"), *span)).collect();
    let (start, duration) = (int(doc, "start"), int(doc, "duration"));
    spans
        .iter()
        .filter(|span| {
            span.get("parent_id")
                .is_some_and(|parent| !parent.is_null())
                && CALLS.contains(&text(span, "kind"))
        })
        .filter_map(|span| {
            let mut at = Some(*span);
            let path = std::iter::from_fn(|| {
                let span = at?;
                at = span
                    .get("parent_id")
                    .and_then(Value::as_str)
                    .and_then(|parent| by_id.get(parent).copied());
                Some(span)
            })
            .find_map(|span| {
                let index = frame_of(frames, origin(span)?)?;
                path_to(frames, stacks, index)
            })?;
            let from = (int(span, "start") - start).max(0);
            let to = (int(span, "start") + int(span, "duration") - start).min(duration);
            (to > from).then_some((from, to, path))
        })
        .collect()
}

/// Each waiter's time in the trace's calls (µs), by its stack, most first: calls at once share the time they
/// overlap, so none is counted twice.
pub(crate) fn waited(
    doc: &Value,
    frames: &[Place],
    stacks: &[(&[usize], i64)],
) -> Vec<(Vec<usize>, f64)> {
    let calls = calls(doc, frames, stacks);
    let mut edges: Vec<i64> = calls
        .iter()
        .flat_map(|(from, to, _)| [*from, *to])
        .collect();
    edges.sort_unstable();
    edges.dedup();
    let mut order: Vec<Vec<usize>> = Vec::new();
    let mut time: HashMap<Vec<usize>, f64> = HashMap::new();
    for pair in edges.windows(2) {
        let (from, to) = (pair[0], pair[1]);
        let open: Vec<&Vec<usize>> = calls
            .iter()
            .filter(|(start, end, _)| *start <= from && *end >= to)
            .map(|(_, _, path)| path)
            .collect();
        for path in &open {
            if !time.contains_key(*path) {
                order.push((*path).clone());
            }
            *time.entry((*path).clone()).or_default() += (to - from) as f64 / open.len() as f64;
        }
    }
    let mut waited: Vec<(Vec<usize>, f64)> = order
        .into_iter()
        .map(|path| {
            let us = time[&path];
            (path, us)
        })
        .collect();
    waited.sort_by(|a, b| b.1.total_cmp(&a.1));
    waited
}
