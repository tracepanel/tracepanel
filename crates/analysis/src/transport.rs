//! A database driver's own HTTP requests: Snowflake's connector logs in, sends each query and downloads its results
//! over HTTPS, and so do BigQuery's, Databricks', ClickHouse's over HTTP, Elasticsearch's and DynamoDB's clients.
//! An SDK or an instrumentation records them as `http.client` spans inside the connection or the statement they
//! serve. They are the driver's transport, not calls the app made: here they leave the trace, their time still in the
//! database span, which keeps their number (`db.http_calls`). A request that carried the trace on to a service that
//! records traces too keeps that link: the database span lists their W3C span ids (`db.http_w3c_span_ids`), so the
//! called service's trace still names the caller's trace, through its database span. An HTTP call the app makes
//! itself while a query runs is under the app's own span, not the query's, and stays.

use super::otel::GENERIC_DB;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use tracepanel_protocol::Received;

/// The kinds of a call to a database: a statement, a connection opened, a datastore's command.
const DATABASES: &[&str] = &[
    "sql",
    "sql.connect",
    GENERIC_DB,
    "mongodb",
    "elasticsearch",
    "cassandra",
    "dynamodb",
    "memcached",
];

/// The `http.client` spans under a database span (and what they recorded under them) leave the trace, in its rows and
/// in its document (what the console shows); the database span counts them and keeps the W3C span ids they carried
/// the trace on with. A trace without any is left as it is.
pub fn normalize(received: &mut Received) {
    let spans = &received.trace.spans;
    if !spans.iter().any(|span| span.kind == "http.client") {
        return;
    }
    let database: HashSet<&str> = spans
        .iter()
        .filter(|span| DATABASES.contains(&span.kind.as_str()))
        .map(|span| span.id.as_str())
        .collect();
    if database.is_empty()
        || !spans.iter().any(|span| {
            span.kind == "http.client"
                && span
                    .parent_id
                    .as_deref()
                    .is_some_and(|parent| database.contains(parent))
        })
    {
        return;
    }
    let parents: HashMap<&str, Option<&str>> = spans
        .iter()
        .map(|span| (span.id.as_str(), span.parent_id.as_deref()))
        .collect();
    let kinds: HashMap<&str, &str> = spans
        .iter()
        .map(|span| (span.id.as_str(), span.kind.as_str()))
        .collect();
    // Each span left out, and each database span's count of its requests and the W3C span ids they carried.
    let mut gone: HashSet<String> = HashSet::new();
    let mut counts: HashMap<String, i64> = HashMap::new();
    let mut carried: HashMap<String, Vec<Value>> = HashMap::new();
    for span in spans {
        let mut parent = span.parent_id.as_deref();
        let mut request = (span.kind == "http.client").then_some(span.id.as_str());
        // A broken tree (a span its own ancestor) stops at its size.
        for _ in 0..spans.len() {
            let Some(id) = parent else { break };
            if database.contains(id) {
                if let Some(request) = request {
                    gone.insert(span.id.clone());
                    if request == span.id {
                        *counts.entry(id.to_owned()).or_default() += 1;
                    }
                    if let Some(w3c) = (span.kind == "http.client")
                        .then(|| span.attrs.get("w3c.span_id"))
                        .flatten()
                        .filter(|w3c| w3c.as_str().is_some_and(|w3c| !w3c.is_empty()))
                    {
                        carried.entry(id.to_owned()).or_default().push(w3c.clone());
                    }
                }
                break;
            }
            if kinds.get(id) == Some(&"http.client") {
                request = Some(id);
            }
            parent = parents.get(id).copied().flatten();
        }
    }
    let Ok(mut doc) = serde_json::from_str::<Value>(&received.doc) else {
        return;
    };
    if let Some(spans) = doc.get_mut("spans").and_then(Value::as_array_mut) {
        spans.retain(|span| !span["id"].as_str().is_some_and(|id| gone.contains(id)));
        for span in spans.iter_mut() {
            let Some(id) = span["id"].as_str().map(str::to_owned) else {
                continue;
            };
            if let Some(count) = counts.get(&id) {
                span["attrs"]["db.http_calls"] = Value::from(*count);
            }
            if let Some(w3c) = carried.remove(&id) {
                span["attrs"]["db.http_w3c_span_ids"] = Value::Array(w3c);
            }
        }
    }
    // What they logged or raised belongs to the query they served.
    for list in ["errors", "logs"] {
        for item in doc
            .get_mut(list)
            .and_then(Value::as_array_mut)
            .into_iter()
            .flatten()
        {
            let mut id = item["span_id"].as_str().map(str::to_owned);
            for _ in 0..gone.len() {
                match id.as_deref().filter(|id| gone.contains(*id)) {
                    Some(current) => {
                        id = parents.get(current).copied().flatten().map(str::to_owned)
                    }
                    None => break,
                }
            }
            if item["span_id"].as_str() != id.as_deref() {
                item["span_id"] = id.map_or(Value::Null, Value::from);
            }
        }
    }
    if let Ok(trace) = serde_json::from_value(doc.clone()) {
        received.trace = trace;
        received.doc = doc.to_string();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn span(id: &str, parent: Option<&str>, kind: &str, name: &str) -> Value {
        serde_json::json!({"id": id, "parent_id": parent, "kind": kind, "name": name, "start": 0, "duration": 1,
                           "status": "ok", "attrs": {}})
    }

    #[test]
    fn a_drivers_requests_leave_the_trace_and_the_apps_own_stay() {
        let doc = serde_json::json!({
            "id": "01M5DRVTRACE00000000000000", "kind": "http", "name": "GET /report", "start": 0, "duration": 10,
            "status": "ok", "attrs": {},
            "spans": [
                span("root", None, "http", "GET /report"),
                span("connect", Some("root"), "sql.connect", "connect snowflake"),
                span("login", Some("connect"), "http.client", "POST acme.snowflakecomputing.com/session/v1/login-request"),
                span("ocsp", Some("login"), "http.client", "POST ocsp.digicert.com/"),
                span("query", Some("root"), "sql", "SELECT orders"),
                span("step", Some("query"), "function", "fetch result"),
                span("chunk", Some("step"), "http.client", "GET sfc-results.s3.amazonaws.com/chunk_0"),
                span("chunk1", Some("step"), "http.client", "GET sfc-results.s3.amazonaws.com/chunk_1"),
                span("proxy", Some("query"), "http.client", "POST results-proxy:8000/fetch"),
                span("api", Some("root"), "http.client", "GET api.example.com/rates"),
            ],
            "logs": [{"span_id": "chunk", "time": 1, "level": "WARNING", "logger": "snowflake.connector",
                      "message": "retrying", "exception": null}],
            "errors": [{"span_id": "ocsp", "type": "TimeoutError", "message": "OCSP"}],
            "links": [], "issues": [],
        });
        let mut doc = doc;
        // Two of them carried the trace on, to services that may record traces.
        doc["spans"][3]["attrs"]["w3c.span_id"] = "00f067aa0ba902b7".into();
        doc["spans"][8]["attrs"]["w3c.span_id"] = "00f067aa0ba902b8".into();
        let mut received = Received {
            trace: serde_json::from_value(doc.clone()).unwrap(),
            doc: doc.to_string(),
        };

        normalize(&mut received);

        let rows: Vec<(&str, Option<&Value>)> = received
            .trace
            .spans
            .iter()
            .map(|span| (span.id.as_str(), span.attrs.get("db.http_calls")))
            .collect();
        assert_eq!(
            rows,
            [
                ("root", None),
                ("connect", Some(&Value::from(1))),
                ("query", Some(&Value::from(3))),
                ("step", None),
                ("api", None),
            ]
        );

        let carried: Vec<(&str, Option<&Value>)> = received
            .trace
            .spans
            .iter()
            .map(|span| (span.id.as_str(), span.attrs.get("db.http_w3c_span_ids")))
            .collect();
        assert_eq!(
            carried,
            [
                ("root", None),
                ("connect", Some(&serde_json::json!(["00f067aa0ba902b7"]))),
                ("query", Some(&serde_json::json!(["00f067aa0ba902b8"]))),
                ("step", None),
                ("api", None),
            ]
        );

        let stored: Value = serde_json::from_str(&received.doc).unwrap();
        assert_eq!(stored["spans"].as_array().unwrap().len(), rows.len());
        assert_eq!(
            stored["spans"][2]["attrs"]["db.http_w3c_span_ids"],
            serde_json::json!(["00f067aa0ba902b8"])
        );
        assert_eq!(stored["logs"][0]["span_id"], "step");
        assert_eq!(stored["errors"][0]["span_id"], "connect");
    }

    #[test]
    fn a_trace_without_a_drivers_request_is_left_as_it_is() {
        let doc = serde_json::json!({
            "id": "01M5DRVTRACE00000000000001", "kind": "http", "name": "GET /", "start": 0, "duration": 10,
            "status": "ok", "attrs": {},
            "spans": [span("root", None, "http", "GET /"), span("query", Some("root"), "sql", "SELECT 1"),
                      span("api", Some("root"), "http.client", "GET api.example.com/")],
            "logs": [], "errors": [], "links": [], "issues": [],
        });
        let text = doc.to_string();
        let mut received = Received {
            trace: serde_json::from_value(doc).unwrap(),
            doc: text.clone(),
        };

        normalize(&mut received);

        assert_eq!(received.doc, text);
    }
}
