//! What a profile's waits were for, by the calls in flight: a function of the app's that waited 3.9 s waited on a
//! query to Snowflake, an HTTP call, a sleep. Its waits are named so (`waiting · SQL snowflake`), the console's
//! Profile tab's rule (`ui/packages/ui/src/lib/waitCalls.ts`), its cases in `schema/waits.json`: a timed profile's
//! (Python's, a JVM's) by the calls its function made in the buckets it waited in, a CPU profile's (Go's, Node's) by
//! the calls its time off the CPU went to (off_cpu).

use crate::compact::int;
use serde_json::Value;

/// The kinds of a call out of the app, as the console's call tree groups them: every system's, and the generic
/// families' (`db`, `messaging`, `rpc`).
pub(crate) const CALLS: [&str; 18] = [
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

/// What every wait is, and how a named one starts: `waiting · SQL postgresql`.
const WAITING: &str = "waiting";

/// A wait's name: what it waited for (`SQL snowflake`, `sleep`), or that no call was in flight.
pub(crate) fn wait_name(label: Option<&str>) -> String {
    match label {
        Some(label) => format!("{WAITING} · {label}"),
        None => format!("{WAITING} (no call)"),
    }
}

/// A non-empty text attribute of a span.
fn attr<'a>(span: &'a Value, key: &str) -> Option<&'a str> {
    span.get("attrs")?
        .get(key)?
        .as_str()
        .filter(|value| !value.is_empty())
}

/// A URL's host, as a browser's URL parser reads its hostname: lower case, an IPv6 address in its brackets.
fn hostname(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    if scheme.is_empty()
        || !scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c))
    {
        return None;
    }
    let authority = rest.split(['/', '?', '#']).next()?;
    let host = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);
    let host = if host.starts_with('[') {
        &host[..=host.find(']')?]
    } else {
        host.split(':').next()?
    };
    (!host.is_empty()).then(|| host.to_ascii_lowercase())
}

/// Where an HTTP call went: its host, as the call tree names it.
fn host_of(span: &Value) -> Option<String> {
    attr(span, "url.full")
        .or_else(|| attr(span, "http.url"))
        .and_then(hostname)
        .or_else(|| {
            attr(span, "server.address")
                .or_else(|| attr(span, "net.peer.name"))
                .map(str::to_owned)
        })
}

/// What a call is, in a wait's name: `SQL snowflake`, `HTTP GET analytics.example.com`, `redis`.
pub(crate) fn call_label(span: &Value) -> String {
    let kind = span.get("kind").and_then(Value::as_str).unwrap_or("");
    let system = ["db.system", "db.vendor", "messaging.system", "rpc.system"]
        .into_iter()
        .find_map(|key| attr(span, key));
    let words = |words: &[Option<&str>]| {
        words
            .iter()
            .flatten()
            .copied()
            .collect::<Vec<_>>()
            .join(" ")
    };
    match kind {
        "sql" => words(&[Some("SQL"), system]),
        "http.client" => {
            let method = attr(span, "http.request.method").or_else(|| attr(span, "http.method"));
            words(&[Some("HTTP"), method, host_of(span).as_deref()])
        }
        _ => match system {
            Some(system) if system != kind => format!("{kind} {system}"),
            _ => kind.to_owned(),
        },
    }
}

/// A call of the trace with its stretch (µs since the trace started).
pub(crate) struct Call<'a> {
    span: &'a Value,
    from: i64,
    to: i64,
}

/// The trace's calls out (queries, HTTP calls, cache and queue calls), on its clock.
pub(crate) fn calls_of(doc: &Value) -> Vec<Call<'_>> {
    let start = int(doc, "start");
    doc.get("spans")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|span| {
            span.get("parent_id")
                .is_some_and(|parent| !parent.is_null())
                && CALLS.contains(&span.get("kind").and_then(Value::as_str).unwrap_or(""))
        })
        .map(|span| Call {
            span,
            from: int(span, "start") - start,
            to: int(span, "start") + int(span, "duration") - start,
        })
        .filter(|call| call.to > call.from)
        .collect()
}

/// The function a call's origin names (`api.py:56 in report`: `report`), as every SDK writes code.origin.
fn made_in(span: &Value) -> Option<&str> {
    attr(span, "code.origin")?.split(" in ").last()
}

/// The same function, however each names it: `report`, `Reports.report`, `(*App).report`.
fn same_name(a: &str, b: &str) -> bool {
    a == b || a.rsplit('.').next() == b.rsplit('.').next()
}

/// The calls in flight in a bucket (µs since the trace started): those a function of the stack made (their
/// code.origin), where any did; else all of them (an origin a stack doesn't name: the driver's, a callback's).
fn in_flight<'c, 'a>(
    calls: &'c [Call<'a>],
    from: i64,
    to: i64,
    names: &[&str],
) -> Vec<&'c Call<'a>> {
    let open: Vec<&Call> = calls
        .iter()
        .filter(|call| call.from < to && call.to > from)
        .collect();
    let own: Vec<&Call> = open
        .iter()
        .copied()
        .filter(|call| {
            made_in(call.span).is_some_and(|made| names.iter().any(|name| same_name(name, made)))
        })
        .collect();
    if own.is_empty() { open } else { own }
}

/// A waiting stack of a timed profile: its frames' functions (outermost first), the function that waited (its
/// innermost), the buckets it was seen in (`[bucket, count]`), and its time (µs).
pub(crate) struct Waiting<'s> {
    pub(crate) names: &'s [&'s str],
    pub(crate) leaf: &'s str,
    pub(crate) seen: &'s [(i64, i64)],
    pub(crate) us: f64,
}

/// A waiting stack's time by what was in flight in each bucket it was seen in, in the order first met: each wait's
/// label (none: no call, and the frame that waited is `waiting` itself) and its µs, the last taking what the shares'
/// rounding left, so that together they are the stack's time.
pub(crate) fn parts(stack: &Waiting, calls: &[Call], width: i64) -> Vec<(Option<String>, f64)> {
    let seen: i64 = stack.seen.iter().map(|(_, count)| count).sum();
    let mut parts: Vec<(Option<String>, f64)> = Vec::new();
    if seen <= 0 {
        return parts;
    }
    for &(bucket, count) in stack.seen {
        let open = in_flight(calls, bucket * width, (bucket + 1) * width, stack.names);
        let labels: Vec<Option<String>> = if open.is_empty() {
            vec![(stack.leaf != WAITING).then(|| stack.leaf.to_owned())]
        } else {
            open.iter()
                .map(|call| Some(call_label(call.span)))
                .collect()
        };
        let share = stack.us * count as f64 / seen as f64 / labels.len() as f64;
        for label in labels {
            match parts.iter_mut().find(|(known, _)| *known == label) {
                Some((_, us)) => *us += share,
                None => parts.push((label, share)),
            }
        }
    }
    let before: f64 = parts.iter().rev().skip(1).map(|(_, us)| us).sum();
    if let Some((_, last)) = parts.last_mut() {
        *last = stack.us - before;
    }
    parts
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_call_is_named_by_its_system_its_method_and_host() {
        let span = |kind: &str, attrs: Value| json!({"kind": kind, "attrs": attrs});

        assert_eq!(
            call_label(&span("sql", json!({"db.system": "snowflake"}))),
            "SQL snowflake"
        );

        assert_eq!(call_label(&span("sql", json!({}))), "SQL");

        assert_eq!(
            call_label(&span(
                "http.client",
                json!({"http.request.method": "GET", "url.full": "https://user:pw@Analytics.Example.com:8443/v1?q=1"})
            )),
            "HTTP GET analytics.example.com"
        );

        assert_eq!(
            call_label(&span(
                "http.client",
                json!({"http.method": "POST", "url.full": "/relative", "server.address": "api"})
            )),
            "HTTP POST api"
        );

        assert_eq!(
            call_label(&span(
                "http.client",
                json!({"url.full": "http://[::1]:8000/"})
            )),
            "HTTP [::1]"
        );

        assert_eq!(
            call_label(&span("redis", json!({"db.system": "redis"}))),
            "redis"
        );

        assert_eq!(
            call_label(&span("kafka", json!({"messaging.system": "kafka"}))),
            "kafka"
        );

        assert_eq!(
            call_label(&span("messaging", json!({"messaging.system": "sns"}))),
            "messaging sns"
        );
    }
}
