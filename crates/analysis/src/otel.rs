//! OpenTelemetry spans, mapped to tracepanel's kinds by the semantic conventions: one implementation for every SDK.
//!
//! An SDK sends a span an OpenTelemetry instrumentation made as it is: kind `otel`, the span's name, and its
//! attributes, with `otel.span_kind`, `otel.scope` and the `code.origin` the SDK adds. Here it becomes what the
//! SDKs' own spans are (`sql`, `redis`, `http.client`) or a kind per system (`mongodb`, `kafka`, `grpc`…), before
//! the issues are found and the trace is stored, so nothing downstream tells them apart. A database, broker or RPC
//! system without a kind of its own gets its family's (`db`, `messaging`, `rpc`), its name kept in `db.system`,
//! `messaging.system` or `rpc.system`: listed and analyzed like the known ones (`ops`). Both the older and the current
//! names of the conventions' attributes are read (`db.statement` and `db.query.text`, `http.method` and
//! `http.request.method`…). A call to a model (the GenAI conventions' `gen_ai.*`) is an `llm` span. Whatever else
//! isn't recognized (a consumer's work, a server span) stays a `function`.

use crate::PLACEHOLDER;
use regex::Regex;
use serde_json::{Map, Value};
use sha1::{Digest, Sha1};
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;
use tracepanel_protocol::{Attrs, Received};

/// The span kind an SDK sends an OpenTelemetry span under.
pub const KIND: &str = "otel";

static WHITESPACE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());
// A comment (`-- a note` to the line's end, `/* sqlcommenter's tags */`), or a string or quoted name, whose `--` and
// `/*` are its text: matched so a comment is told from a string that looks like one.
static COMMENT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?s)(--[^\n]*)|(/\*.*?\*/)|'(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`"#).unwrap()
});
static IN_LIST: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"(?i)\bIN \({PLACEHOLDER}(?:, ?{PLACEHOLDER})*\)")).unwrap()
});
// One part of a table's name, bare or quoted: "standard SQL", `MySQL`, [SQL Server].
const PART: &str = r#"(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[\w$]+)"#;
// The table a statement reads or writes, with its schema (Prisma's "public"."category", MySQL's `shop`.`book`).
static TABLE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?i)\b(?:FROM|INTO|UPDATE|JOIN)\s+({PART}(?:\s*\.\s*{PART})*)"
    ))
    .unwrap()
});
static PARTS: LazyLock<Regex> = LazyLock::new(|| Regex::new(PART).unwrap());
static COUNT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^\s*SELECT\s+COUNT\(").unwrap());
// The query parameters whose values never get recorded, as the SDKs mask them.
static SENSITIVE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)pass(word|wd)?|secret|token|api_?key|auth|cookie|session|csrf|signature|private",
    )
    .unwrap()
});
const MASK: &str = "********";

/// Database systems that speak SQL: their spans become `sql`.
const SQL_SYSTEMS: &[&str] = &[
    "postgresql",
    "mysql",
    "mariadb",
    "sqlite",
    "mssql",
    "oracle",
    "db2",
    "cockroachdb",
    "clickhouse",
    "h2",
    "hsqldb",
    "derby",
    "trino",
    "snowflake",
    "redshift",
    "other_sql",
    "sybase",
    "teradata",
    "firebird",
    "informix",
    "hive",
    "spanner",
    "vertica",
    "pervasive",
    "ingres",
    "maxdb",
    "progress",
    "netezza",
    "interbase",
    "cloudscape",
    "adabas",
    "edb",
    "filemaker",
    "instantdb",
    "intersystems_cache",
    "mssqlcompact",
    "pointbase",
];

/// Datastores with a span kind of their own.
const DATASTORES: &[(&str, &str)] = &[
    ("mongodb", "mongodb"),
    ("elasticsearch", "elasticsearch"),
    ("opensearch", "elasticsearch"),
    ("cassandra", "cassandra"),
    ("dynamodb", "dynamodb"),
    ("memcached", "memcached"),
];

/// The kinds of the systems without one of their own: any other database, broker or RPC system, its own name kept in
/// `db.system`, `messaging.system` or `rpc.system`. A new system needs no code to be recorded, listed and analyzed.
pub const GENERIC_DB: &str = "db";
pub const GENERIC_MESSAGING: &str = "messaging";
pub const GENERIC_RPC: &str = "rpc";

/// Message brokers with a span kind of their own.
const BROKERS: &[(&str, &str)] = &[
    ("kafka", "kafka"),
    ("rabbitmq", "rabbitmq"),
    ("aws_sqs", "sqs"),
    ("aws.sqs", "sqs"),
    ("sqs", "sqs"),
];

/// A mapped span: its kind, name, attributes, whether the mapping found it failed, and why it became what it is (what
/// the console shows under "As received over OTLP").
#[derive(Debug, Clone, PartialEq)]
pub struct Mapped {
    pub kind: String,
    pub name: String,
    pub attrs: Attrs,
    pub error: bool,
    pub reason: String,
}

/// Map the trace's `otel` spans, in its rows and in its document (what the console shows). A trace without any is
/// left as it is.
pub fn normalize(received: &mut Received) {
    if !received.trace.spans.iter().any(|span| span.kind == KIND) {
        return;
    }
    let Ok(mut doc) = serde_json::from_str::<Value>(&received.doc) else {
        return;
    };
    fold(&mut doc);
    if let Some(spans) = doc.get_mut("spans").and_then(Value::as_array_mut) {
        for span in spans.iter_mut().filter(|span| span["kind"] == KIND) {
            map_in_place(span);
        }
    }
    if let Ok(trace) = serde_json::from_value(doc.clone()) {
        received.trace = trace;
        received.doc = doc.to_string();
    }
}

/// Name and group the trace's queries without their comments, in its rows and in its document (what the console
/// shows): an SDK names a statement by its first word and groups it by its whole text, a leading `/* … */` and its
/// traceparent included. The statement itself keeps them. A trace without a commented query is left as it is.
pub fn uncomment(received: &mut Received) {
    let commented = |kind: &str, attrs: &Attrs| {
        kind == "sql"
            && attrs
                .get("db.statement")
                .and_then(Value::as_str)
                .is_some_and(|sql| sql.contains("/*") || sql.contains("--"))
    };
    if !received
        .trace
        .spans
        .iter()
        .any(|span| commented(&span.kind, &span.attrs))
    {
        return;
    }
    let Ok(mut doc) = serde_json::from_str::<Value>(&received.doc) else {
        return;
    };
    for span in doc
        .get_mut("spans")
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
    {
        let Some(attrs) = span.get("attrs").and_then(Value::as_object) else {
            continue;
        };
        if !commented(span["kind"].as_str().unwrap_or_default(), attrs) {
            continue;
        }
        let bare = uncommented(attrs["db.statement"].as_str().unwrap_or_default());
        // An older SDK's statement on one line: its `--` comment runs to the end, and nothing is left to name.
        if bare.is_empty() {
            continue;
        }
        span["name"] = Value::from(span_name(&bare));
        span["attrs"]["db.fingerprint"] = Value::from(IN_LIST.replace_all(&bare, "IN (...)"));
    }
    if let Ok(trace) = serde_json::from_value(doc.clone()) {
        received.trace = trace;
        received.doc = doc.to_string();
    }
}

/// Apollo Router's own instrumentation scope.
const APOLLO_ROUTER: &str = "apollo-router";
/// Grafbase Gateway's instrumentation scope: every span it exports.
const GRAFBASE: &str = "grafbase";
/// The steps of a GraphQL gateway's own that stay in the tree when they take this long (µs): parsing and planning a
/// query, its own work. Its other steps (Apollo Router's `supergraph`, `execution`, `fetch`, `subgraph`; Cosmo
/// Router's `Operation - Normalize`, `Engine - Fetch`…) are stages every request goes through, their time their
/// calls' or nothing.
const ROUTER_STEP_SHOWN: i64 = 5_000;

/// A GraphQL gateway's own stage, by the scope its spans come in (and what kind of span it is): the steps of it
/// that stay when slow, or `None` for a span that is no stage of a gateway's. Its request stays, and so do its
/// requests to subgraphs, which are calls.
/// - Apollo Router (`apollo-router`): its internal spans.
/// - WunderGraph Cosmo Router (`wundergraph/cosmo/router/...`, its handlers' and its engine's tracers): every span
///   but a call (its `Authenticate` and `Load Persisted Operation` are client spans with no URL). Its requests, in
///   and out, are otelhttp's, of a scope of their own.
/// - Hive Gateway and GraphQL Mesh (The Guild's OpenTelemetry plugin, its default tracer `gateway`): its
///   `graphql.*` spans of an operation.
/// - Hive Router (`graphql-hive.router`): its internal spans (its stages, `http.inflight` around a request to a
///   subgraph) and its `graphql.operation` server span under the request.
/// - Grafbase Gateway (`grafbase`): its internal spans but its request to a subgraph, and its `graphql` server
///   span under the request.
fn gateway_stage(
    scope: &str,
    name: &str,
    span_kind: &str,
    call: bool,
) -> Option<&'static [&'static str]> {
    match scope {
        APOLLO_ROUTER if span_kind == "internal" => Some(&["parse_query", "query_planning"]),
        _ if scope.starts_with("wundergraph/cosmo/router/") && !call => {
            Some(&["Operation - Parse", "Operation - Plan"])
        }
        "gateway"
            if matches!(
                name,
                "graphql.context" | "graphql.parse" | "graphql.validate" | "graphql.execute"
            ) || name == "graphql.operation"
                || name.starts_with("graphql.operation ") =>
        {
            Some(&["graphql.parse"])
        }
        "graphql-hive.router" if matches!(span_kind, "internal" | "server") => {
            Some(&["graphql.parse", "graphql.plan"])
        }
        GRAFBASE if matches!(span_kind, "internal" | "server") && !call => {
            Some(&["prepare operation"])
        }
        _ => None,
    }
}

/// A GraphQL gateway's span around its request to a subgraph (Hive Gateway's `subgraph.execute (books)`, Hive
/// Router's `graphql.subgraph.operation`, Grafbase Gateway's `subgraph-request`): a client span with no URL of its
/// own, a call under it.
fn gateway_scope(scope: &str) -> bool {
    matches!(
        scope,
        APOLLO_ROUTER | "gateway" | "graphql-hive.router" | GRAFBASE
    ) || scope.starts_with("wundergraph/cosmo/router/")
}

/// Leave out the spans that only wrap others, their children moved up to the span above them, their time still in
/// it: a GraphQL gateway's stages, a gateway's client span with no URL around its call to a subgraph, and a client
/// span around another client span to the same URL (Apollo Router's `subgraph_request` around its `http_request`:
/// one call, its inner span the one whose id the subgraph got).
fn fold(doc: &mut Value) {
    let Some(spans) = doc.get("spans").and_then(Value::as_array) else {
        return;
    };
    let attr = |span: &Value, key: &str| span["attrs"][key].as_str().map(str::to_owned);
    let url = |span: &Value| attr(span, "url.full").or_else(|| attr(span, "http.url"));
    let client = |span: &Value| {
        span["kind"] == KIND && attr(span, "otel.span_kind").as_deref() == Some("client")
    };
    // The URLs each span's client spans called: a client span calling one of its own is a wrapper.
    let mut called: HashMap<&str, Vec<String>> = HashMap::new();
    for span in spans.iter().filter(|span| client(span)) {
        if let (Some(parent), Some(url)) = (span["parent_id"].as_str(), url(span)) {
            called.entry(parent).or_default().push(url);
        }
    }
    // A call: a span with a URL, a method or an RPC system, of a client (or Grafbase's internal request).
    let call = |span: &Value| {
        url(span).is_some()
            || ["http.request.method", "http.method", "rpc.system"]
                .iter()
                .any(|key| attr(span, key).is_some())
    };
    let parents: HashMap<&str, &str> = spans
        .iter()
        .filter_map(|span| Some((span["id"].as_str()?, span["parent_id"].as_str()?)))
        .collect();
    // The spans a call is under, at any depth.
    let mut above_call: HashSet<&str> = HashSet::new();
    for span in spans
        .iter()
        .filter(|span| span["kind"] == KIND && call(span))
    {
        let mut parent = span["parent_id"].as_str();
        for _ in 0..spans.len() {
            let Some(id) = parent.filter(|id| above_call.insert(id)) else {
                break;
            };
            parent = parents.get(id).copied();
        }
    }
    let mut gone: HashMap<String, Option<String>> = HashMap::new();
    for span in spans.iter().filter(|span| span["kind"] == KIND) {
        let (Some(id), parent) = (span["id"].as_str(), span["parent_id"].as_str()) else {
            continue;
        };
        let scope = attr(span, "otel.scope").unwrap_or_default();
        let name = span["name"].as_str().unwrap_or_default();
        let span_kind = attr(span, "otel.span_kind").unwrap_or_default();
        let stage = gateway_stage(&scope, name, &span_kind, call(span)).is_some_and(|shown| {
            !(shown.contains(&name) && span["duration"].as_i64().unwrap_or(0) >= ROUTER_STEP_SHOWN)
        });
        let wrapper = client(span)
            && url(span).is_some_and(|url| called.get(id).is_some_and(|urls| urls.contains(&url)));
        let around_call =
            client(span) && gateway_scope(&scope) && !call(span) && above_call.contains(id);
        if stage || wrapper || around_call {
            gone.insert(id.to_owned(), parent.map(str::to_owned));
        }
    }
    if gone.is_empty() {
        return;
    }
    // The nearest span above that stays; a loop in broken parent ids stops at the number of spans left out.
    let kept = |mut id: Option<String>| {
        for _ in 0..=gone.len() {
            match id.as_deref().and_then(|current| gone.get(current)) {
                Some(parent) => id.clone_from(parent),
                None => break,
            }
        }
        id
    };
    let mut moved: Vec<Value> = Vec::new();
    for span in doc["spans"].as_array().into_iter().flatten() {
        if span["id"].as_str().is_some_and(|id| gone.contains_key(id)) {
            continue;
        }
        let mut span = span.clone();
        let parent = kept(span["parent_id"].as_str().map(str::to_owned));
        span["parent_id"] = parent.map_or(Value::Null, Value::from);
        moved.push(span);
    }
    doc["spans"] = Value::Array(moved);
    for list in ["errors", "logs"] {
        for item in doc
            .get_mut(list)
            .and_then(Value::as_array_mut)
            .into_iter()
            .flatten()
        {
            if let Some(id) = item["span_id"].as_str().filter(|id| gone.contains_key(*id)) {
                item["span_id"] = kept(Some(id.to_owned())).map_or(Value::Null, Value::from);
            }
        }
    }
}

fn map_in_place(span: &mut Value) {
    let name = span["name"].as_str().unwrap_or_default().to_owned();
    let attrs = match span.get_mut("attrs").map(Value::take) {
        Some(Value::Object(attrs)) => attrs,
        _ => Map::new(),
    };
    let mapped = map(&name, &attrs);
    span["received"] = received(name, attrs, &mapped);
    if mapped.error {
        span["status"] = Value::from("error");
    } else if answered_4xx(&mapped) {
        span["status"] = Value::from("ok");
    }
    span["kind"] = Value::from(mapped.kind);
    span["name"] = Value::from(mapped.name);
    span["attrs"] = Value::Object(mapped.attrs);
}

/// The URL attributes whose credentials and sensitive query values are masked, as a mapped span's own `url.full` is.
const URLS: &[&str] = &["url.full", "http.url", "http.target"];

/// The span as it came, next to what it became: its name, its OpenTelemetry kind and scope, why it was mapped as it
/// was, and its attributes. One the mapped span keeps with the same value is named, not copied (`same`: its key
/// there), so a statement or a step's attributes aren't stored twice. URLs are masked as the mapped span's are.
fn received(name: String, attrs: Attrs, mapped: &Mapped) -> Value {
    let mut out = Map::new();
    let mut changed = Map::new();
    let mut same = Map::new();
    for (key, value) in attrs {
        match key.as_str() {
            "otel.span_kind" => {
                out.insert("span_kind".into(), value);
                continue;
            }
            "otel.scope" => {
                out.insert("scope".into(), value);
                continue;
            }
            _ => {}
        }
        let value = match value {
            Value::String(url) if URLS.contains(&key.as_str()) => Value::from(safe_url(&url)),
            Value::String(query) if key == "url.query" => Value::from(masked_query(&query)),
            other => other,
        };
        // Kept as it came, or renamed (`http.method` as `http.request.method`): the key it is under, never the
        // fingerprint, which `uncomment` rewrites.
        if mapped.attrs.get(&key) == Some(&value) {
            same.insert(key.clone(), Value::from(key));
        } else if let Some((kept, _)) = mapped
            .attrs
            .iter()
            .find(|(kept, each)| *kept != "db.fingerprint" && **each == value)
        {
            same.insert(key, Value::from(kept.clone()));
        } else {
            changed.insert(key, value);
        }
    }
    out.insert("name".into(), Value::from(name));
    out.insert("mapped_as".into(), Value::from(mapped.reason.clone()));
    if !changed.is_empty() {
        out.insert("attrs".into(), Value::Object(changed));
    }
    if !same.is_empty() {
        out.insert("same".into(), Value::Object(same));
    }
    Value::Object(out)
}

/// One OpenTelemetry span, by its name and attributes, as tracepanel's kind, and why: which attributes made it a call
/// (or why it is none), and whether a call carried the trace on to the service it called.
pub fn map(name: &str, attrs: &Attrs) -> Mapped {
    let span_kind = text(attrs, &["otel.span_kind"]).unwrap_or_default();
    let mut mapped = classify(name, attrs, &span_kind);
    let call = matches!(
        mapped.kind.as_str(),
        "http.client" | "grpc" | GENERIC_RPC | GENERIC_MESSAGING | "kafka" | "rabbitmq" | "sqs"
    );
    if matches!(span_kind.as_str(), "client" | "producer") {
        if attrs.contains_key("w3c.span_id") {
            mapped
                .reason
                .push_str(". It carries the trace on: links the trace of the service it called");
        } else if call || mapped.kind == "function" {
            mapped
                .reason
                .push_str(". It carries no trace on: not linked to the service it called");
        }
    }
    mapped
}

/// The first of these attributes that is set, by its name: what a mapping read.
fn which<'a>(attrs: &Attrs, keys: &[&'a str]) -> &'a str {
    keys.iter()
        .copied()
        .find(|key| match attrs.get(*key) {
            Some(Value::String(value)) => !value.is_empty(),
            Some(Value::Null) | None => false,
            Some(_) => true,
        })
        .unwrap_or(keys[0])
}

fn because(mut mapped: Mapped, reason: String) -> Mapped {
    mapped.reason = reason;
    mapped
}

fn classify(name: &str, attrs: &Attrs, span_kind: &str) -> Mapped {
    if let Some(mapped) = llm(name, attrs) {
        let reason = "A call to a model: the GenAI conventions' gen_ai.* attributes".to_owned();
        return because(mapped, reason);
    }
    let system = db_system(attrs);
    let sql_system = system
        .as_deref()
        .filter(|system| SQL_SYSTEMS.contains(system));
    if let Some(system) = system.as_deref() {
        let from = which(attrs, &["db.system.name", "db.system"]);
        // A SQL span without a statement is the driver's own work (`pg.connect`): no query to show.
        if sql_system.is_some() && text(attrs, &["db.query.text", "db.statement"]).is_some() {
            let statement = which(attrs, &["db.query.text", "db.statement"]);
            let reason = format!("SQL: {system} from {from}, statement from {statement}");
            return because(sql(name, attrs, system), reason);
        }
        if system == "redis" {
            let command = which(
                attrs,
                &[
                    "db.operation.name",
                    "db.operation",
                    "db.query.text",
                    "db.statement",
                ],
            );
            let reason = format!("Redis: from {from}, the command from {command}");
            return because(redis(attrs), reason);
        }
        if let Some((_, kind)) = DATASTORES.iter().find(|(name, _)| *name == system) {
            let reason = format!("A {system} call: from {from}");
            return because(datastore(name, attrs, kind, system), reason);
        }
        // Any other database (neo4j, couchbase, influxdb…): the family's kind, `db`, with its own name kept.
        if sql_system.is_none() {
            let reason = format!("A database call: {system} from {from}");
            return because(datastore(name, attrs, GENERIC_DB, system), reason);
        }
    }
    if text(attrs, &["rpc.system"]).as_deref() == Some("aws-api")
        && text(attrs, &["rpc.service"]).as_deref() == Some("DynamoDB")
    {
        let reason = "A DynamoDB call: rpc.system aws-api, rpc.service DynamoDB".to_owned();
        return because(datastore(name, attrs, "dynamodb", "dynamodb"), reason);
    }
    if let Some(mapped) = messaging(name, attrs, span_kind) {
        let system = text(attrs, &["messaging.system"]).unwrap_or_default();
        let reason = format!("A message sent: {system} from messaging.system, a {span_kind} span");
        return because(mapped, reason);
    }
    if span_kind == "client"
        && let Some(system) = text(attrs, &["rpc.system"]).map(|system| system.to_lowercase())
    {
        // gRPC has a kind of its own; any other RPC system (thrift, jsonrpc, aws-api…) the family's, `rpc`.
        let kind = if system == "grpc" {
            "grpc"
        } else {
            GENERIC_RPC
        };
        let reason = format!("An RPC call: {system} from rpc.system, a client span");
        return because(rpc(name, attrs, kind, &system), reason);
    }
    let has_url = text(attrs, &["url.full", "http.url"]).is_some();
    let url = which(attrs, &["url.full", "http.url"]);
    if span_kind == "client"
        && let Some(method) = text(attrs, &["http.request.method", "http.method"])
    {
        let from = which(attrs, &["http.request.method", "http.method"]);
        let reason = if has_url {
            format!("HTTP call: method from {from}, URL from {url}")
        } else {
            let host = which(attrs, &["server.address", "net.peer.name", "http.host"]);
            let path = which(attrs, &["url.path", "http.target"]);
            format!("HTTP call: method from {from}, URL from {host} and {path}")
        };
        return because(http_client(attrs, &method), reason);
    }
    // Grafbase Gateway's request to a subgraph, which it records as an internal span.
    if span_kind == "internal"
        && text(attrs, &["otel.scope"]).as_deref() == Some(GRAFBASE)
        && let (Some(method), true) = (
            text(attrs, &["http.request.method"]),
            text(attrs, &["url.full"]).is_some(),
        )
    {
        let reason = "Grafbase Gateway's request to a subgraph: an internal span with http.request.method and \
                      url.full. It carries the trace on: links the trace of the service it called"
            .to_owned();
        return because(http_client(attrs, &method), reason);
    }
    // A call that names only its URL: Apollo Router's request to a subgraph, always a POST of the subgraph's query.
    if span_kind == "client"
        && text(attrs, &["otel.scope"]).as_deref() == Some(APOLLO_ROUTER)
        && has_url
    {
        let reason = format!("Apollo Router's call to a subgraph: a POST to {url}");
        return because(http_client(attrs, "POST"), reason);
    }
    let reason = match (sql_system, span_kind) {
        (Some(system), _) => format!(
            "Not a query: a {system} span with no statement (the driver's own work), kept as a step"
        ),
        (None, "client") if has_url => {
            "Not a call: a client span with a URL but no HTTP method, kept as a step".to_owned()
        }
        (None, "client") => "Not a call: a client span with no HTTP method or URL, no rpc.system \
                             or messaging.system, kept as a step"
            .to_owned(),
        (None, "producer") => {
            "Not a message sent: a producer span with no messaging.system, kept as a step"
                .to_owned()
        }
        (None, "consumer") => "A consumer's work: a step".to_owned(),
        (None, "server") => "A server span: a step".to_owned(),
        _ => "An internal span: a step".to_owned(),
    };
    Mapped {
        kind: "function".into(),
        name: name.to_owned(),
        attrs: attrs.clone(),
        error: false,
        reason,
    }
}

// ---------- attributes ----------

/// The first of these attributes that is set, as text (a number as its digits).
fn text(attrs: &Attrs, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| match attrs.get(*key) {
        Some(Value::String(value)) if !value.is_empty() => Some(value.clone()),
        Some(Value::Number(value)) => Some(value.to_string()),
        Some(Value::Bool(value)) => Some(value.to_string()),
        _ => None,
    })
}

fn number(attrs: &Attrs, keys: &[&str]) -> Option<i64> {
    keys.iter().find_map(|key| match attrs.get(*key) {
        Some(Value::Number(value)) => value.as_i64(),
        Some(Value::String(value)) => value.parse().ok(),
        _ => None,
    })
}

/// The database system, as the older conventions name it (`oracle`, `mssql`) whichever the span uses.
fn db_system(attrs: &Attrs) -> Option<String> {
    let system = text(attrs, &["db.system.name", "db.system"])?.to_lowercase();
    Some(
        match system.as_str() {
            "microsoft.sql_server" => "mssql",
            "oracle.db" => "oracle",
            "ibm.db2" => "db2",
            "aws.dynamodb" => "dynamodb",
            "aws.redshift" => "redshift",
            "h2database" => "h2",
            "postgres" => "postgresql",
            other => other,
        }
        .to_owned(),
    )
}

/// `server.address` and `server.port`, from either convention, and the instrumentation that made the span.
fn server(attrs: &Attrs, into: &mut Attrs) {
    if let Some(address) = text(
        attrs,
        &["server.address", "net.peer.name", "net.sock.peer.addr"],
    ) {
        into.insert("server.address".into(), Value::from(address));
    }
    if let Some(port) = number(
        attrs,
        &["server.port", "net.peer.port", "net.sock.peer.port"],
    ) {
        into.insert("server.port".into(), Value::from(port));
    }
}

/// What every mapped span keeps: where in the project it was called, which instrumentation made it, and the W3C span
/// id of a call that carried the trace on (what links it to the trace the service it reached made).
fn common(attrs: &Attrs) -> Attrs {
    let mut kept = Map::new();
    for key in [
        "code.origin",
        "otel.scope",
        "error.type",
        "w3c.span_id",
        "db.response.returned_rows",
    ] {
        if let Some(value) = attrs.get(key) {
            kept.insert(key.into(), value.clone());
        }
    }
    kept
}

/// The client library, short, from the instrumentation's scope: `psycopg`, `pg`, `otelsql`.
fn client(attrs: &Attrs) -> String {
    let scope = text(attrs, &["otel.scope"]).unwrap_or_default();
    let last = scope
        .rsplit(['/', '.'])
        .next()
        .unwrap_or_default()
        .trim_start_matches("instrumentation-");
    if last.is_empty() {
        "otel".into()
    } else {
        last.to_owned()
    }
}

// ---------- LLM ----------

/// The older conventions' names of the GenAI attributes, and the current ones. The cache's writes were
/// `cache_creation` until the GenAI conventions renamed them `cache_write`.
const GEN_AI_RENAMED: &[(&str, &str)] = &[
    ("gen_ai.system", "gen_ai.provider.name"),
    ("gen_ai.usage.prompt_tokens", "gen_ai.usage.input_tokens"),
    (
        "gen_ai.usage.completion_tokens",
        "gen_ai.usage.output_tokens",
    ),
    (
        "gen_ai.usage.cache_creation.input_tokens",
        "gen_ai.usage.cache_write.input_tokens",
    ),
];

/// A call to a model, as the GenAI conventions record it (OpenAI's, Anthropic's, Bedrock's instrumentations…): an
/// `llm` span with its `gen_ai.*` attributes, in their current names. An instrumentation on the older conventions
/// names the provider in `gen_ai.system` and may name no operation: a call with a model is a chat. The agent's and
/// the tools' spans (`invoke_agent`, `execute_tool`) are no model call.
fn llm(name: &str, attrs: &Attrs) -> Option<Mapped> {
    let named = text(attrs, &["gen_ai.operation.name"]);
    let older = named.is_none()
        && text(attrs, &["gen_ai.system"]).is_some()
        && text(attrs, &["gen_ai.request.model"]).is_some();
    if !older && !crate::llm::model_call(attrs) {
        return None;
    }
    let mut out = common(attrs);
    for (key, value) in attrs {
        if key.starts_with("gen_ai.") {
            out.insert(key.clone(), value.clone());
        }
    }
    for (older, current) in GEN_AI_RENAMED {
        if let Some(value) = out.remove(*older) {
            out.entry(*current).or_insert(value);
        }
    }
    if older {
        out.insert("gen_ai.operation.name".into(), Value::from("chat"));
    }
    server(attrs, &mut out);
    Some(Mapped {
        kind: crate::llm::KIND.into(),
        name: name.to_owned(),
        attrs: out,
        error: false,
        reason: String::new(),
    })
}

// ---------- SQL ----------

/// A statement on one line, as the SDKs record it: a line comment made a `/* */` one, so the line it ended still
/// reads as SQL.
pub fn statement(sql: &str) -> String {
    let closed = if sql.contains("--") {
        COMMENT.replace_all(sql, |found: &regex::Captures| match found.get(1) {
            Some(line) => format!("/* {} */", line.as_str()[2..].trim().replace("*/", "* /")),
            None => found[0].to_owned(),
        })
    } else {
        sql.into()
    };
    WHITESPACE.replace_all(&closed, " ").trim().to_owned()
}

/// A statement without its comments (an ORM's or sqlcommenter's tags, a note), on one line: what names it and groups
/// it, since a comment that carries the request's traceparent differs in every query.
pub fn uncommented(sql: &str) -> String {
    if !sql.contains("--") && !sql.contains("/*") {
        return statement(sql);
    }
    let bare = COMMENT.replace_all(sql, |found: &regex::Captures| {
        if found.get(1).is_some() || found.get(2).is_some() {
            " ".to_owned()
        } else {
            found[0].to_owned()
        }
    });
    statement(&bare)
}

/// A statement from its first word on, its leading comments (an ORM's or sqlcommenter's tags) skipped: what a check of
/// what it does reads, with no copy made.
pub fn after_comments(sql: &str) -> &str {
    let mut rest = sql.trim_start();
    loop {
        let skipped = if let Some(comment) = rest.strip_prefix("/*") {
            comment.split_once("*/").map_or("", |(_, after)| after)
        } else if let Some(comment) = rest.strip_prefix("--") {
            comment.split_once('\n').map_or("", |(_, after)| after)
        } else {
            return rest;
        };
        rest = skipped.trim_start();
    }
}

/// Whether a statement is a SELECT, after its leading comments.
pub fn is_select(sql: &str) -> bool {
    after_comments(sql)
        .get(..6)
        .is_some_and(|verb| verb.eq_ignore_ascii_case("SELECT"))
}

/// What the agent groups queries by: the one-line statement without its comments, its IN lists collapsed.
pub fn fingerprint(sql: &str) -> String {
    IN_LIST
        .replace_all(&uncommented(sql), "IN (...)")
        .into_owned()
}

/// A query's span name: its verb and its table, its schema and quotes left out (`SELECT users`, `SELECT COUNT
/// orders`): the same rule in every SDK.
pub fn span_name(sql: &str) -> String {
    let mut verb = sql
        .split_whitespace()
        .next()
        .map_or_else(|| "SQL".to_owned(), str::to_uppercase);
    if COUNT.is_match(sql) {
        verb = "SELECT COUNT".into();
    }
    let table = TABLE.captures(sql).and_then(|found| {
        let part = PARTS.find_iter(&found[1]).last()?.as_str();
        let bare = part
            .strip_prefix(['"', '`', '['])
            .and_then(|inner| inner.strip_suffix(['"', '`', ']']))
            .unwrap_or(part);
        Some(bare.to_owned())
    });
    match table {
        Some(table) => format!("{verb} {table}"),
        None => verb,
    }
}

fn sql(name: &str, attrs: &Attrs, system: &str) -> Mapped {
    let raw = text(attrs, &["db.query.text", "db.statement"]).unwrap_or_else(|| name.to_owned());
    let one_line = statement(&raw);
    let vendor = match system {
        "mariadb" => "mysql",
        other => other,
    };
    let namespace = text(attrs, &["db.namespace", "db.name"]).map(|name| {
        // SQLite names its database after a file: the file's name, as the SDKs do.
        if vendor == "sqlite" {
            name.rsplit(['/', '\\'])
                .next()
                .unwrap_or_default()
                .to_owned()
        } else {
            name
        }
    });
    let mut out = common(attrs);
    out.insert("db.client".into(), Value::from(client(attrs)));
    out.insert("db.system".into(), Value::from(system));
    out.insert("db.vendor".into(), Value::from(vendor));
    // A database the span doesn't name (the conventions' `other_sql`) is plain `sql` where it is shown.
    let unnamed = match system {
        "other_sql" => "sql",
        other => other,
    };
    out.insert(
        "db.alias".into(),
        Value::from(namespace.clone().unwrap_or_else(|| unnamed.to_owned())),
    );
    if let Some(namespace) = namespace {
        out.insert("db.namespace".into(), Value::from(namespace));
    }
    out.insert("db.statement".into(), Value::from(one_line.clone()));
    out.insert("db.fingerprint".into(), Value::from(fingerprint(&raw)));
    server(attrs, &mut out);
    if let Some((values, names)) = params(attrs) {
        out.insert("db.params_hash".into(), Value::from(params_hash(&values)));
        out.insert("db.params".into(), Value::Array(values));
        if let Some(names) = names {
            out.insert(
                "db.param_names".into(),
                Value::Array(names.into_iter().map(Value::from).collect()),
            );
        }
    }
    Mapped {
        kind: "sql".into(),
        name: span_name(&uncommented(&raw)),
        attrs: out,
        error: false,
        reason: String::new(),
    }
}

/// A statement's parameters, from whichever form the instrumentation records them in, with their names when it has
/// them. None when it records none (most do, unless asked to).
fn params(attrs: &Attrs) -> Option<(Vec<Value>, Option<Vec<String>>)> {
    for prefix in ["db.query.parameter.", "db.sql.args."] {
        let mut keyed: Vec<(&str, &Value)> = attrs
            .iter()
            .filter_map(|(key, value)| key.strip_prefix(prefix).map(|key| (key, value)))
            .collect();
        if keyed.is_empty() {
            continue;
        }
        let numeric = keyed.iter().all(|(key, _)| key.parse::<u64>().is_ok());
        if numeric {
            keyed.sort_by_key(|(key, _)| key.parse::<u64>().unwrap_or(0));
        } else {
            keyed.sort_by_key(|(key, _)| *key);
        }
        let values = keyed.iter().map(|(_, value)| (*value).clone()).collect();
        let names = (!numeric).then(|| keyed.iter().map(|(key, _)| (*key).to_owned()).collect());
        return Some((values, names));
    }
    match attrs.get("db.postgresql.values") {
        Some(Value::Array(values)) => return Some((values.clone(), None)),
        Some(Value::String(json)) => {
            if let Ok(Value::Array(values)) = serde_json::from_str(json) {
                return Some((values, None));
            }
        }
        _ => {}
    }
    attrs
        .get("db.statement.parameters")
        .and_then(Value::as_str)
        .and_then(python_literal)
}

/// A stable hash of the parameters, 12 hex digits as the SDKs send.
fn params_hash(values: &[Value]) -> String {
    let digest = Sha1::digest(serde_json::to_string(values).unwrap_or_default());
    digest[..6]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Python's repr of a tuple, a list or a dict of plain values (`(1, 'a')`, `{'id': 2}`), what Python's DB-API
/// instrumentation records: the values, and the names of a dict's keys. None when it holds anything else.
fn python_literal(text: &str) -> Option<(Vec<Value>, Option<Vec<String>>)> {
    let text = text.trim();
    let (open, close) = (text.chars().next()?, text.chars().last()?);
    let inner = text.get(1..text.len().checked_sub(1)?)?;
    match (open, close) {
        ('(', ')') | ('[', ']') => {
            let values: Option<Vec<Value>> = split_top(inner)
                .into_iter()
                .map(|item| python_scalar(&item))
                .collect();
            Some((values?, None))
        }
        ('{', '}') => {
            let mut names = Vec::new();
            let mut values = Vec::new();
            for item in split_top(inner) {
                let (key, value) = item.split_once(':')?;
                match python_scalar(key)? {
                    Value::String(name) => names.push(name),
                    _ => return None,
                }
                values.push(python_scalar(value)?);
            }
            Some((values, Some(names)))
        }
        _ => None,
    }
}

/// The items of a repr's sequence, split on the commas outside quotes.
fn split_top(inner: &str) -> Vec<String> {
    let mut items = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut escaped = false;
    for ch in inner.chars() {
        match quote {
            Some(open) => {
                current.push(ch);
                if escaped {
                    escaped = false;
                } else if ch == '\\' {
                    escaped = true;
                } else if ch == open {
                    quote = None;
                }
            }
            None if ch == '\'' || ch == '"' => {
                quote = Some(ch);
                current.push(ch);
            }
            None if ch == ',' => items.push(std::mem::take(&mut current)),
            None => current.push(ch),
        }
    }
    if !current.trim().is_empty() {
        items.push(current);
    }
    items
        .into_iter()
        .map(|item| item.trim().to_owned())
        .collect()
}

fn python_scalar(item: &str) -> Option<Value> {
    let item = item.trim();
    match item {
        "None" => return Some(Value::Null),
        "True" => return Some(Value::Bool(true)),
        "False" => return Some(Value::Bool(false)),
        _ => {}
    }
    if let Ok(int) = item.parse::<i64>() {
        return Some(Value::from(int));
    }
    if let Ok(float) = item.parse::<f64>() {
        return Some(Value::from(float));
    }
    let quote = item.chars().next()?;
    if (quote == '\'' || quote == '"') && item.len() >= 2 && item.ends_with(quote) {
        let body = &item[1..item.len() - 1];
        return Some(Value::from(
            body.replace("\\'", "'")
                .replace("\\\"", "\"")
                .replace("\\\\", "\\"),
        ));
    }
    None
}

// ---------- Redis and the other datastores ----------

fn redis(attrs: &Attrs) -> Mapped {
    let raw = text(attrs, &["db.query.text", "db.statement"]).unwrap_or_default();
    let mut words = raw.split_whitespace();
    let first = words.next().map(str::to_uppercase);
    // A pipeline: its commands go together, one span, its key how many it sent (as the SDKs record it).
    let pipeline = number(attrs, &["db.redis.pipeline_length"]);
    let command = if pipeline.is_some() {
        "PIPELINE".to_owned()
    } else {
        text(attrs, &["db.operation.name", "db.operation"])
            .map(|command| command.to_uppercase())
            .or(first)
            .unwrap_or_else(|| "COMMAND".into())
    };
    // A key the instrumentation masked (`GET ?`) names nothing.
    let key: Option<Value> = match pipeline {
        Some(length) => Some(Value::from(length)),
        None => words
            .next()
            .filter(|key| *key != "?")
            .map(|key| Value::from(key.to_owned())),
    };
    let index = number(attrs, &["db.redis.database_index"])
        .or_else(|| number(attrs, &["db.namespace"]))
        .filter(|index| *index != 0);
    let mut out = common(attrs);
    out.insert("db.system".into(), Value::from("redis"));
    out.insert("db.operation".into(), Value::from(command.clone()));
    out.insert("redis.key".into(), key.clone().unwrap_or(Value::Null));
    out.insert(
        "redis.alias".into(),
        Value::from(index.map_or_else(|| "redis".to_owned(), |index| format!("redis/{index}"))),
    );
    if let Some(index) = index {
        out.insert("db.namespace".into(), Value::from(index.to_string()));
    }
    server(attrs, &mut out);
    let name = match key {
        Some(Value::String(key)) => format!("{command} {key}"),
        _ => command,
    };
    Mapped {
        kind: "redis".into(),
        name,
        attrs: out,
        error: false,
        reason: String::new(),
    }
}

fn datastore(name: &str, attrs: &Attrs, kind: &str, system: &str) -> Mapped {
    // Python's pymongo instrumentation puts the command's name in db.statement (`find`), and no db.operation.
    let one_word = text(attrs, &["db.query.text", "db.statement"])
        .filter(|statement| !statement.contains(char::is_whitespace));
    let operation = text(attrs, &["db.operation.name", "db.operation", "rpc.method"]).or(one_word);
    let collection = text(
        attrs,
        &[
            "db.collection.name",
            "db.mongodb.collection",
            "db.cassandra.table",
            "db.sql.table",
            "db.elasticsearch.path_parts.index",
        ],
    )
    .or_else(|| match attrs.get("aws.dynamodb.table_names") {
        Some(Value::Array(tables)) => tables.first().and_then(Value::as_str).map(str::to_owned),
        _ => None,
    });
    let namespace = text(attrs, &["db.namespace", "db.name", "db.cassandra.keyspace"]);
    let mut out = common(attrs);
    out.insert("db.system".into(), Value::from(system));
    if let Some(operation) = &operation {
        out.insert("db.operation".into(), Value::from(operation.clone()));
    }
    if let Some(collection) = &collection {
        out.insert("db.collection.name".into(), Value::from(collection.clone()));
    }
    if let Some(namespace) = namespace {
        out.insert("db.namespace".into(), Value::from(namespace));
    }
    if let Some(statement) = text(attrs, &["db.query.text", "db.statement"]) {
        out.insert("db.statement".into(), Value::from(statement));
    }
    server(attrs, &mut out);
    let name = match (operation, collection) {
        (Some(operation), Some(collection)) => format!("{operation} {collection}"),
        (Some(operation), None) => operation,
        _ => name.to_owned(),
    };
    Mapped {
        kind: kind.into(),
        name,
        attrs: out,
        error: false,
        reason: String::new(),
    }
}

// ---------- messaging, gRPC, HTTP ----------

/// A message sent to a broker. What a consumer does with one is its own work, and stays a function.
fn messaging(name: &str, attrs: &Attrs, span_kind: &str) -> Option<Mapped> {
    let system = text(attrs, &["messaging.system"])?.to_lowercase();
    // A known broker its kind, and its name as tracepanel spells it; any other (nats, pulsar…) `messaging`, as sent.
    let (kind, system) = BROKERS
        .iter()
        .find(|(name, _)| *name == system)
        .map_or((GENERIC_MESSAGING, system.clone()), |(_, kind)| {
            (*kind, (*kind).to_owned())
        });
    let operation = text(
        attrs,
        &[
            "messaging.operation.type",
            "messaging.operation.name",
            "messaging.operation",
        ],
    )
    .unwrap_or_else(|| "publish".into());
    let sending = span_kind == "producer"
        || (span_kind == "client" && matches!(operation.as_str(), "publish" | "send" | "create"));
    if !sending {
        return None;
    }
    let destination = text(
        attrs,
        &["messaging.destination.name", "messaging.destination"],
    );
    let mut out = common(attrs);
    out.insert("messaging.system".into(), Value::from(system));
    out.insert("messaging.operation".into(), Value::from(operation.clone()));
    if let Some(destination) = &destination {
        out.insert(
            "messaging.destination.name".into(),
            Value::from(destination.clone()),
        );
    }
    server(attrs, &mut out);
    Some(Mapped {
        kind: kind.into(),
        name: destination.map_or_else(
            || name.to_owned(),
            |destination| format!("{operation} {destination}"),
        ),
        attrs: out,
        error: false,
        reason: String::new(),
    })
}

/// An RPC call: gRPC (whose status code says whether it failed), or any other RPC system as the `rpc` kind.
fn rpc(name: &str, attrs: &Attrs, kind: &str, system: &str) -> Mapped {
    let service = text(attrs, &["rpc.service"]);
    let method = text(attrs, &["rpc.method"]);
    let code = number(attrs, &["rpc.grpc.status_code"]);
    let mut out = common(attrs);
    out.insert("rpc.system".into(), Value::from(system));
    if let Some(service) = &service {
        out.insert("rpc.service".into(), Value::from(service.clone()));
    }
    if let Some(method) = &method {
        out.insert("rpc.method".into(), Value::from(method.clone()));
    }
    if let Some(code) = code {
        out.insert("rpc.grpc.status_code".into(), Value::from(code));
    }
    server(attrs, &mut out);
    let name = match (service, method) {
        (Some(service), Some(method)) => format!("{service}/{method}"),
        _ => name.to_owned(),
    };
    Mapped {
        kind: kind.into(),
        name,
        attrs: out,
        error: code.is_some_and(|code| code != 0) || attrs.contains_key("error.type"),
        reason: String::new(),
    }
}

fn http_client(attrs: &Attrs, method: &str) -> Mapped {
    let method = method.to_uppercase();
    let url = text(attrs, &["url.full", "http.url"]).or_else(|| {
        let host = text(attrs, &["server.address", "net.peer.name", "http.host"])?;
        let scheme = text(attrs, &["url.scheme", "http.scheme"]).unwrap_or_else(|| "http".into());
        let path = text(attrs, &["url.path", "http.target"]).unwrap_or_else(|| "/".into());
        Some(format!("{scheme}://{host}{path}"))
    });
    let parts = url.as_deref().map(split_url);
    let status = number(attrs, &["http.response.status_code", "http.status_code"]);
    let mut out = common(attrs);
    out.insert("http.request.method".into(), Value::from(method.clone()));
    if let Some(url) = &url {
        out.insert("url.full".into(), Value::from(safe_url(url)));
    }
    let scheme = parts
        .as_ref()
        .map(|parts| parts.scheme.clone())
        .or_else(|| text(attrs, &["url.scheme", "http.scheme"]))
        .unwrap_or_else(|| "http".into());
    out.insert("url.scheme".into(), Value::from(scheme.clone()));
    server(attrs, &mut out);
    if let Some(parts) = &parts {
        out.entry("server.address")
            .or_insert_with(|| Value::from(parts.host.clone()));
        let port = parts
            .port
            .unwrap_or(if scheme == "https" { 443 } else { 80 });
        out.entry("server.port")
            .or_insert_with(|| Value::from(port));
    }
    if let Some(status) = status {
        out.insert("http.response.status_code".into(), Value::from(status));
    }
    let host = text(&out, &["server.address"]).unwrap_or_default();
    let path = parts.map_or_else(|| "/".to_owned(), |parts| parts.path);
    Mapped {
        kind: "http.client".into(),
        name: format!("{method} {host}{path}"),
        error: call_failed(status, text(attrs, &["error.type"]).as_deref()),
        reason: String::new(),
        attrs: out,
    }
}

/// Whether an HTTP call failed: answered 5xx, or with no answer at all (`error.type` names a connection error or a
/// timeout). A 4xx answer is no failure of the call: OpenTelemetry's `error.type` then names the status code ("404"),
/// as its HTTP conventions set the span's status to Error; the console shows such a call as a warning.
fn call_failed(status: Option<i64>, error: Option<&str>) -> bool {
    match status {
        Some(status) if status >= 500 => true,
        Some(status) => error.is_some_and(|error| error != status.to_string()),
        None => error.is_some(),
    }
}

/// An HTTP call answered 4xx and that failed in no other way: no error, whatever its OpenTelemetry status says.
fn answered_4xx(mapped: &Mapped) -> bool {
    mapped.kind == "http.client"
        && !mapped.error
        && mapped
            .attrs
            .get("http.response.status_code")
            .and_then(Value::as_i64)
            .is_some_and(|status| (400..500).contains(&status))
}

struct UrlParts {
    scheme: String,
    host: String,
    port: Option<i64>,
    path: String,
}

fn split_url(url: &str) -> UrlParts {
    let (scheme, rest) = url.split_once("://").unwrap_or(("http", url));
    let (authority, path) = match rest.find(['/', '?', '#']) {
        Some(at) => (&rest[..at], &rest[at..]),
        None => (rest, "/"),
    };
    let authority = authority.rsplit('@').next().unwrap_or_default();
    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port)) if !host.ends_with(']') || host.starts_with('[') => {
            (host.to_owned(), port.parse().ok())
        }
        _ => (authority.to_owned(), None),
    };
    let path = path.split(['?', '#']).next().unwrap_or("/");
    UrlParts {
        scheme: scheme.to_lowercase(),
        host,
        port,
        path: if path.is_empty() {
            "/".into()
        } else {
            path.into()
        },
    }
}

/// The URL without its credentials, and with the values of sensitive query parameters masked, as the SDKs do.
fn safe_url(url: &str) -> String {
    let (scheme, rest) = match url.split_once("://") {
        Some((scheme, rest)) => (Some(scheme), rest),
        None => (None, url),
    };
    let (before_fragment, _) = rest.split_once('#').unwrap_or((rest, ""));
    let (address, query) = before_fragment
        .split_once('?')
        .unwrap_or((before_fragment, ""));
    let (authority, path) = match address.find('/') {
        Some(at) => (&address[..at], &address[at..]),
        None => (address, ""),
    };
    let authority = authority.rsplit('@').next().unwrap_or_default();
    let query = masked_query(query);
    let mut safe = match scheme {
        Some(scheme) => format!("{scheme}://{authority}{path}"),
        None => format!("{authority}{path}"),
    };
    if !query.is_empty() {
        safe.push('?');
        safe.push_str(&query);
    }
    safe
}

/// A query string with the values of its sensitive parameters masked.
fn masked_query(query: &str) -> String {
    query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| match pair.split_once('=') {
            Some((key, _)) if SENSITIVE.is_match(key) => format!("{key}={MASK}"),
            _ => pair.to_owned(),
        })
        .collect::<Vec<_>>()
        .join("&")
}
