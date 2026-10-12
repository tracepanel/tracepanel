//! OpenTelemetry spans, mapped to tracepanel's kinds by the semantic conventions: one implementation for every SDK.
//!
//! An SDK sends a span an OpenTelemetry instrumentation made as it is: kind `otel`, the span's name, and its
//! attributes, with `otel.span_kind`, `otel.scope` and the `code.origin` the SDK adds. Here it becomes what the
//! SDKs' own spans are (`sql`, `redis`, `http.client`) or a kind per system (`mongodb`, `kafka`, `grpc`…), before
//! the issues are found and the trace is stored, so nothing downstream tells them apart. Both the older and the
//! current names of the conventions' attributes are read (`db.statement` and `db.query.text`, `http.method` and
//! `http.request.method`…). Whatever isn't recognized stays a `function`.

use regex::Regex;
use serde_json::{Map, Value};
use sha1::{Digest, Sha1};
use std::sync::LazyLock;
use tracepanel_protocol::{Attrs, Received};

/// The span kind an SDK sends an OpenTelemetry span under.
pub const KIND: &str = "otel";

static WHITESPACE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());
static IN_LIST: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\bIN \((?:%s|\?|\$\d+)(?:, ?(?:%s|\?|\$\d+))*\)").unwrap());
static TABLE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("(?i)\\b(?:FROM|INTO|UPDATE|JOIN)\\s+[`\"\\[]?([\\w.]+)").unwrap());
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

/// Message brokers with a span kind of their own.
const BROKERS: &[(&str, &str)] = &[
    ("kafka", "kafka"),
    ("rabbitmq", "rabbitmq"),
    ("aws_sqs", "sqs"),
    ("aws.sqs", "sqs"),
    ("sqs", "sqs"),
];

/// A mapped span: its kind, name, attributes, and whether the mapping found it failed.
#[derive(Debug, Clone, PartialEq)]
pub struct Mapped {
    pub kind: String,
    pub name: String,
    pub attrs: Attrs,
    pub error: bool,
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

fn map_in_place(span: &mut Value) {
    let name = span["name"].as_str().unwrap_or_default().to_owned();
    let attrs = span
        .get("attrs")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mapped = map(&name, &attrs);
    span["kind"] = Value::from(mapped.kind);
    span["name"] = Value::from(mapped.name);
    span["attrs"] = Value::Object(mapped.attrs);
    if mapped.error {
        span["status"] = Value::from("error");
    }
}

/// One OpenTelemetry span, by its name and attributes, as tracepanel's kind.
pub fn map(name: &str, attrs: &Attrs) -> Mapped {
    let span_kind = text(attrs, &["otel.span_kind"]).unwrap_or_default();
    if let Some(system) = db_system(attrs) {
        // A SQL span without a statement is the driver's own work (`pg.connect`): no query to show.
        if SQL_SYSTEMS.contains(&system.as_str())
            && text(attrs, &["db.query.text", "db.statement"]).is_some()
        {
            return sql(name, attrs, &system);
        }
        if system == "redis" {
            return redis(attrs);
        }
        if let Some((_, kind)) = DATASTORES.iter().find(|(name, _)| *name == system) {
            return datastore(name, attrs, kind, &system);
        }
    }
    if text(attrs, &["rpc.system"]).as_deref() == Some("aws-api")
        && text(attrs, &["rpc.service"]).as_deref() == Some("DynamoDB")
    {
        return datastore(name, attrs, "dynamodb", "dynamodb");
    }
    if let Some(mapped) = messaging(name, attrs, &span_kind) {
        return mapped;
    }
    if text(attrs, &["rpc.system"]).as_deref() == Some("grpc") && span_kind == "client" {
        return grpc(name, attrs);
    }
    if span_kind == "client"
        && let Some(method) = text(attrs, &["http.request.method", "http.method"])
    {
        return http_client(attrs, &method);
    }
    Mapped {
        kind: "function".into(),
        name: name.to_owned(),
        attrs: attrs.clone(),
        error: false,
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

/// What every mapped span keeps: where in the project it was called, and which instrumentation made it.
fn common(attrs: &Attrs) -> Attrs {
    let mut kept = Map::new();
    for key in ["code.origin", "otel.scope", "error.type"] {
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

// ---------- SQL ----------

/// A statement on one line, as the SDKs record it.
pub fn statement(sql: &str) -> String {
    WHITESPACE.replace_all(sql, " ").trim().to_owned()
}

/// What the agent groups queries by: the one-line statement, its IN lists collapsed.
pub fn fingerprint(sql: &str) -> String {
    IN_LIST
        .replace_all(&statement(sql), "IN (...)")
        .into_owned()
}

/// A query's span name: its verb and its table (`SELECT users`, `SELECT COUNT orders`).
pub fn span_name(sql: &str) -> String {
    let mut verb = sql
        .split_whitespace()
        .next()
        .map_or_else(|| "SQL".to_owned(), str::to_uppercase);
    if COUNT.is_match(sql) {
        verb = "SELECT COUNT".into();
    }
    match TABLE.captures(sql) {
        Some(table) => format!("{verb} {}", &table[1]),
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
    out.insert(
        "db.alias".into(),
        Value::from(namespace.clone().unwrap_or_else(|| system.to_owned())),
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
        name: span_name(&one_line),
        attrs: out,
        error: false,
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
    }
}

// ---------- messaging, gRPC, HTTP ----------

/// A message sent to a broker. What a consumer does with one is its own work, and stays a function.
fn messaging(name: &str, attrs: &Attrs, span_kind: &str) -> Option<Mapped> {
    let system = text(attrs, &["messaging.system"])?.to_lowercase();
    let (_, kind) = BROKERS.iter().find(|(name, _)| *name == system)?;
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
    out.insert("messaging.system".into(), Value::from(*kind));
    out.insert("messaging.operation".into(), Value::from(operation.clone()));
    if let Some(destination) = &destination {
        out.insert(
            "messaging.destination.name".into(),
            Value::from(destination.clone()),
        );
    }
    server(attrs, &mut out);
    Some(Mapped {
        kind: (*kind).into(),
        name: destination.map_or_else(
            || name.to_owned(),
            |destination| format!("{operation} {destination}"),
        ),
        attrs: out,
        error: false,
    })
}

fn grpc(name: &str, attrs: &Attrs) -> Mapped {
    let service = text(attrs, &["rpc.service"]);
    let method = text(attrs, &["rpc.method"]);
    let code = number(attrs, &["rpc.grpc.status_code"]);
    let mut out = common(attrs);
    out.insert("rpc.system".into(), Value::from("grpc"));
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
        kind: "grpc".into(),
        name,
        attrs: out,
        error: code.is_some_and(|code| code != 0),
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
        error: status.is_some_and(|status| status >= 400) || attrs.contains_key("error.type"),
        attrs: out,
    }
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
    let query: Vec<String> = query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| match pair.split_once('=') {
            Some((key, _)) if SENSITIVE.is_match(key) => format!("{key}={MASK}"),
            _ => pair.to_owned(),
        })
        .collect();
    let mut safe = match scheme {
        Some(scheme) => format!("{scheme}://{authority}{path}"),
        None => format!("{authority}{path}"),
    };
    if !query.is_empty() {
        safe.push('?');
        safe.push_str(&query.join("&"));
    }
    safe
}
