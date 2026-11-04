//! What a profile's waits and calls are named: a call by what it is (`SQL snowflake`, `HTTP GET
//! analytics.example.com`), a wait by what it waited for (`waiting · SQL snowflake`, `waiting · sleep`), as the
//! console's Profile tab names them (`ui/packages/ui/src/lib/waitCalls.ts`): a timed profile's calls are shares of
//! their own (shares), a CPU profile's (Go's, Node's) time off the CPU waits, named by the call it went to (off_cpu).

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
