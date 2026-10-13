//! Time spent waiting, found as issues: a task waiting in its queue for a free worker, and an event loop waiting on a
//! blocking call.
//!
//! - `queue-wait`: a task trace whose `task.queue_wait` (from enqueue to start, the SDKs' task queues record it) is
//!   over `queue_wait_ms`. Its workers are busy: every task behind it waits as well.
//! - `blocking-call`: SQL, an HTTP call, Redis or a cache operation made synchronously on an event loop's thread (the
//!   SDK marks it `code.blocks_event_loop`): every other request the loop serves waits for it. One issue per place in
//!   the code and kind of call, once they cost `BLOCKING_MIN_US` together: a microsecond's call blocks nothing much.

use crate::{culprit_key, issue, issue_key, milliseconds, py_str, text};
use std::collections::HashMap;
use tracepanel_protocol::{Issue, Span, Thresholds, Trace};

/// Blocking calls from one place, under this together, aren't worth an issue.
const BLOCKING_MIN_US: i64 = 5_000;

const QUEUE_WAIT_HINT: &str = "The task waited in its queue for a worker: they were all busy. Run more workers, or \
                               give slow tasks a queue of their own so quick ones don't wait behind them.";

/// What runs instead of the blocking call, by its kind.
fn blocking_hint(kind: &str) -> &'static str {
    match kind {
        "sql" => {
            "This query ran on the event loop's thread: every other request waited for it. In Django use the async ORM \
             (aget, afirst, async for) or sync_to_async; elsewhere an async driver (asyncpg, psycopg's \
             AsyncConnection, aiosqlite)."
        }
        "http.client" => {
            "This call ran on the event loop's thread: every other request waited until it answered. Use an async \
             client: httpx.AsyncClient or aiohttp."
        }
        "redis" => "This command ran on the event loop's thread. Use redis.asyncio's client.",
        "cache" => {
            "This cache call ran on the event loop's thread. Use the cache's async API (aget, aset)."
        }
        _ => {
            "This call ran on the event loop's thread. Use an async client, or run it in a thread (asyncio.to_thread, \
             sync_to_async)."
        }
    }
}

fn noun(kind: &str, count: usize) -> String {
    let (one, many) = match kind {
        "sql" => ("query", "queries"),
        "http.client" => ("HTTP call", "HTTP calls"),
        "redis" => ("Redis command", "Redis commands"),
        "cache" => ("cache call", "cache calls"),
        _ => ("call", "calls"),
    };
    format!("{count} {}", if count == 1 { one } else { many })
}

pub(crate) fn queue_issues(trace: &Trace, thresholds: &Thresholds) -> Vec<Issue> {
    let waited = trace
        .attrs
        .get("task.queue_wait")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(0);
    if trace.kind != "task" || waited < thresholds.queue_wait_ms * 1000 {
        return Vec::new();
    }
    let queue = text(&trace.attrs, "task.queue");
    let place = queue
        .as_deref()
        .map_or(String::new(), |queue| format!(" in {queue}"));
    vec![issue(
        issue_key("queue-wait", &[Some(&trace.name), queue.as_deref()]),
        "queue-wait",
        format!(
            "Queue wait: {} ms{place} · {}",
            milliseconds(waited),
            trace.name
        ),
        Some(trace.name.clone()),
        Some(QUEUE_WAIT_HINT),
        1,
        Vec::new(),
    )]
}

fn blocks(span: &Span) -> bool {
    span.attrs.get("code.blocks_event_loop") == Some(&serde_json::Value::Bool(true))
}

pub(crate) fn blocking_issues(trace: &Trace) -> Vec<Issue> {
    let mut order: Vec<(String, String)> = Vec::new();
    let mut groups: HashMap<(String, String), Vec<&Span>> = HashMap::new();
    for span in trace.spans.iter().filter(|span| blocks(span)) {
        let key = (span.kind.clone(), py_str(span.attrs.get("code.origin")));
        if !groups.contains_key(&key) {
            order.push(key.clone());
        }
        groups.entry(key).or_default().push(span);
    }
    order
        .into_iter()
        .filter_map(|key| {
            let spans = &groups[&key];
            let total: i64 = spans.iter().map(|span| span.duration).sum();
            if total < BLOCKING_MIN_US {
                return None;
            }
            let (kind, origin) = key;
            let culprit = (!origin.is_empty()).then_some(origin);
            Some(issue(
                issue_key(
                    "blocking-call",
                    &[Some(&kind), culprit_key(culprit.as_deref()).as_deref()],
                ),
                "blocking-call",
                format!(
                    "Blocking call in async code: {}, {} ms · {}",
                    noun(&kind, spans.len()),
                    milliseconds(total),
                    spans[0].name
                ),
                culprit,
                Some(blocking_hint(&kind)),
                spans.len(),
                spans.iter().map(|span| span.id.clone()).collect(),
            ))
        })
        .collect()
}
