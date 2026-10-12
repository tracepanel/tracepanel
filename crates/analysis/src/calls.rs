//! Operations: every call the app makes to another system, described one way. A SQL statement, a Redis command, a
//! cache operation, an HTTP or RPC call, a datastore command, a published message: each has a system, a family that
//! sets the rules, a target (the database, the instance, the host, the topic), an operation (the verb, command or
//! method) and a template (what repeats of it share). The store keeps them in one table, the console lists them one
//! way, and the issues come from one engine with one table of rules per family.
//!
//! The span's kind gives the family. The console groups a page by the system:
//! - `sql` for every SQL database (its vendor is the operation's `vendor`), `http` for outgoing HTTP calls, `cache` for
//!   a cache library's operations (its backend in `vendor`);
//! - the kind for the other known kinds (`redis`, `mongodb`, `kafka`, `grpc`…);
//! - the system's own name for the generic kinds (`db`, `messaging`, `rpc`), which the OpenTelemetry mapping gives to
//!   any database, broker or RPC system without a kind of its own: `neo4j`, `nats`, `thrift`. A new system is listed
//!   and analyzed by its family's rules, with no code of its own.

use super::*;

/// The kinds that are operations, and their families.
const KINDS: &[(&str, &str)] = &[
    ("sql", "sql"),
    ("redis", "redis"),
    ("cache", "cache"),
    ("mongodb", "datastore"),
    ("elasticsearch", "datastore"),
    ("cassandra", "datastore"),
    ("dynamodb", "datastore"),
    ("memcached", "datastore"),
    (otel::GENERIC_DB, "datastore"),
    ("kafka", "messaging"),
    ("rabbitmq", "messaging"),
    ("sqs", "messaging"),
    (otel::GENERIC_MESSAGING, "messaging"),
    ("grpc", "rpc"),
    (otel::GENERIC_RPC, "rpc"),
    ("http.client", "http"),
];

/// The families in the order the console lists their systems.
pub const FAMILIES: &[&str] = &[
    "sql",
    "redis",
    "cache",
    "datastore",
    "messaging",
    "rpc",
    "http",
];

/// The family of a span kind, or None for a span that isn't an operation.
pub fn family(kind: &str) -> Option<&'static str> {
    KINDS
        .iter()
        .find(|(name, _)| *name == kind)
        .map(|(_, family)| *family)
}

/// How titles name a system: its known spelling, else its name as sent.
pub fn display_name(system: &str) -> String {
    match system {
        "sql" => "Database",
        "cache" => "Cache",
        "http" => "HTTP calls",
        "redis" => "Redis",
        "mongodb" => "MongoDB",
        "elasticsearch" => "Elasticsearch",
        "opensearch" => "OpenSearch",
        "cassandra" => "Cassandra",
        "dynamodb" => "DynamoDB",
        "memcached" => "Memcached",
        "neo4j" => "Neo4j",
        "couchbase" => "Couchbase",
        "influxdb" => "InfluxDB",
        "kafka" => "Kafka",
        "rabbitmq" => "RabbitMQ",
        "sqs" => "Amazon SQS",
        "nats" => "NATS",
        "pulsar" => "Pulsar",
        "google_pubsub" => "Google Pub/Sub",
        "grpc" => "gRPC",
        "thrift" => "Thrift",
        "jsonrpc" => "JSON-RPC",
        "aws-api" => "AWS",
        other => other,
    }
    .to_owned()
}

/// The system a span's operations are listed under (see the module's doc).
fn system_of(span: &Span) -> String {
    let named = |key: &str| text(&span.attrs, key).map(|name| name.to_lowercase());
    match span.kind.as_str() {
        "http.client" => "http".into(),
        kind if kind == otel::GENERIC_DB => named("db.system").unwrap_or_else(|| kind.into()),
        kind if kind == otel::GENERIC_MESSAGING => {
            named("messaging.system").unwrap_or_else(|| kind.into())
        }
        kind if kind == otel::GENERIC_RPC => named("rpc.system").unwrap_or_else(|| kind.into()),
        kind => kind.into(),
    }
}

/// One operation, as the store keeps it and the engine groups it.
#[derive(Debug, Clone, PartialEq)]
pub struct Operation {
    /// What the console lists it under: sql, redis, cache, http, mongodb, kafka, grpc, neo4j… (see the module's doc).
    pub system: String,
    pub family: &'static str,
    /// Where it went: the database alias, the Redis or cache alias, the host, the topic or queue, the RPC service, the
    /// datastore's database.
    pub target: String,
    /// The verb: SELECT, GET, get, POST, find, publish, the RPC method.
    pub op: String,
    /// What repeats of it share: the SQL fingerprint, the key or path with its ids as `{id}`, the collection, the
    /// destination.
    pub template: String,
    /// The span's name, as the console shows it.
    pub name: String,
    /// The operation in full: the SQL statement, the command with its key, the URL.
    pub statement: Option<String>,
    /// SQL: the database vendor; a cache: its backend (redis, locmem).
    pub vendor: Option<String>,
    /// SQL: the hash of the parameters.
    pub params_hash: Option<String>,
    /// Redis: what sent the command (direct, cache, task).
    pub via: Option<&'static str>,
    /// A cache get: whether it found the key.
    pub hit: Option<bool>,
}

/// A statement's verb, as the console filters it (`op:select`): its first word, upper case.
pub fn sql_verb(statement: &str) -> String {
    statement
        .split_whitespace()
        .next()
        .unwrap_or("SQL")
        .trim_start_matches('(')
        .to_uppercase()
}

/// The operation a span is, or None when the span is not a call to another system.
pub fn operation(trace: &Trace, span: &Span) -> Option<Operation> {
    let family = family(&span.kind)?;
    let attrs = &span.attrs;
    let mut operation = Operation {
        system: system_of(span),
        family,
        target: String::new(),
        op: String::new(),
        template: String::new(),
        name: span.name.clone(),
        statement: None,
        vendor: None,
        params_hash: None,
        via: None,
        hit: None,
    };
    match family {
        "sql" => {
            // str(attrs.get("db.fingerprint", span.name)): the name only when the key is missing.
            let fingerprint = attrs
                .get("db.fingerprint")
                .map_or_else(|| span.name.clone(), |value| py_str(Some(value)));
            operation.target = or_default(attrs, "db.alias", "default");
            operation.op = sql_verb(&fingerprint);
            operation.statement = text(attrs, "db.statement").or_else(|| Some(fingerprint.clone()));
            operation.template = fingerprint;
            operation.vendor = if truthy(attrs.get("db.system")) {
                text(attrs, "db.system")
            } else {
                text(attrs, "db.vendor")
            };
            operation.params_hash = text(attrs, "db.params_hash");
        }
        "redis" => {
            let (alias, command, template) = redis_command(span);
            operation.statement = Some(span.name.clone());
            (operation.target, operation.op, operation.template) = (alias, command, template);
            operation.via = Some(redis_via(trace, span));
        }
        "cache" => {
            let (alias, op, template) = cache_op(span);
            (operation.target, operation.op, operation.template) = (alias, op, template);
            operation.vendor = text(attrs, "cache.system");
            operation.hit = attrs.get("cache.hit").and_then(Value::as_bool);
        }
        "http" => {
            let (method, host, path) = http_endpoint(span);
            operation.statement = text(attrs, "url.full");
            (operation.target, operation.op, operation.template) = (host, method, path);
        }
        "rpc" => {
            let service = or_default(attrs, "rpc.service", "");
            let method = or_default(attrs, "rpc.method", "");
            operation.template = format!("{service}/{method}");
            (operation.target, operation.op) = (service, method);
        }
        "datastore" => {
            operation.target =
                text(attrs, "db.namespace").unwrap_or_else(|| operation.system.clone());
            operation.op = or_default(attrs, "db.operation", "");
            operation.template =
                text(attrs, "db.collection.name").map_or_else(String::new, |name| template(&name));
            operation.statement = text(attrs, "db.statement");
        }
        // messaging
        _ => {
            let destination = or_default(attrs, "messaging.destination.name", "");
            operation.op = or_default(attrs, "messaging.operation", "publish");
            operation.template = template(&destination);
            operation.target = destination;
        }
    }
    Some(operation)
}

// ---------- the engine ----------

/// A family's rules: what its calls are called, its hints, and which issues it can have.
struct Rules {
    /// "calls", "Redis commands", "MongoDB commands": how a title counts them.
    label: String,
    repeated_hint: &'static str,
    /// None: repeating the same one is an action each time (a publish), never a duplicate.
    duplicates_hint: Option<&'static str>,
    /// Repeats are an issue only when they cost `n_plus_one_min_ms` together (an in-memory store).
    cheap: bool,
    /// The slow-call issue: (issue kind, title prefix). Its threshold is `slow_http_ms`.
    slow: Option<(&'static str, String)>,
}

const DATASTORE_REPEATED: &str =
    "Fetch the items in one query (an `$in` filter, a multi-get, a batch) instead of one per item.";
const DATASTORE_DUPLICATES: &str = "Run the query once and reuse the result for the request.";
const MESSAGING_REPEATED: &str = "Publish the messages in one batch (the client's batch or bulk send) instead of one call per item.";
const RPC_REPEATED: &str =
    "Ask for the items in one call (a batch or streaming method) instead of one call per item.";
const RPC_DUPLICATES: &str = "Make the call once and reuse the answer for the request.";
/// Datastores that live in memory: a repeat costs a fraction of a millisecond.
const IN_MEMORY: &[&str] = &["memcached"];

/// The rules of a family, for one of its systems (whose name the titles use).
fn rules(family: &str, system: &str) -> Option<Rules> {
    let name = display_name(system);
    Some(match family {
        "http" => Rules {
            label: "calls".into(),
            repeated_hint: HTTP_REPEATED,
            duplicates_hint: Some(HTTP_DUPLICATES),
            cheap: false,
            slow: Some(("slow-http", "Slow HTTP call".into())),
        },
        "redis" => Rules {
            label: "Redis commands".into(),
            repeated_hint: REDIS_REPEATED,
            duplicates_hint: Some(CACHE_DUPLICATES),
            cheap: true,
            slow: None,
        },
        "cache" => Rules {
            label: "cache calls".into(),
            repeated_hint: CACHE_REPEATED,
            duplicates_hint: Some(CACHE_DUPLICATES),
            cheap: true,
            slow: None,
        },
        "datastore" => Rules {
            label: format!("{name} commands"),
            repeated_hint: if IN_MEMORY.contains(&system) {
                CACHE_REPEATED
            } else {
                DATASTORE_REPEATED
            },
            duplicates_hint: Some(if IN_MEMORY.contains(&system) {
                CACHE_DUPLICATES
            } else {
                DATASTORE_DUPLICATES
            }),
            cheap: IN_MEMORY.contains(&system),
            slow: None,
        },
        "messaging" => Rules {
            label: format!("{name} messages"),
            repeated_hint: MESSAGING_REPEATED,
            duplicates_hint: None,
            cheap: false,
            slow: None,
        },
        "rpc" => Rules {
            label: format!("{name} calls"),
            repeated_hint: RPC_REPEATED,
            duplicates_hint: Some(RPC_DUPLICATES),
            cheap: false,
            slow: Some(("slow-http", format!("Slow {name} call"))),
        },
        _ => return None,
    })
}

// Datastore operations that only read: a repeat of one with the same query is wasted.
const DATASTORE_READS: &[&str] = &[
    "find",
    "findone",
    "find_one",
    "aggregate",
    "count",
    "countdocuments",
    "count_documents",
    "distinct",
    "get",
    "gets",
    "mget",
    "search",
    "msearch",
    "select",
    "query",
    "match",
    "scan",
    "getitem",
    "batchgetitem",
];

/// One call, as the engine sees it: what makes two of them the same request or the same item.
fn call_of<'a>(operation: &Operation, span: &'a Span) -> Call<'a> {
    match span.kind.as_str() {
        "http.client" => http_call(span),
        "redis" => redis_call(span),
        "cache" => cache_call(span),
        _ => {
            let what = format!("{} {}", operation.op, operation.template)
                .trim()
                .to_owned();
            let title = if operation.family == "rpc" {
                operation.template.clone()
            } else {
                what.clone()
            };
            // The exact query, when the span has it (a datastore's statement); else each call is its own: repeats
            // count as an N+1, and no two are known to be the same.
            let exact = operation
                .statement
                .clone()
                .filter(|statement| statement.contains(char::is_whitespace))
                .map(|statement| format!("{} {statement}", operation.target));
            let read = operation.family == "rpc"
                || DATASTORE_READS.contains(&operation.op.to_lowercase().replace(' ', "").as_str());
            Call {
                span,
                group: format!("{} {} {what}", operation.system, operation.target),
                title,
                read: read && exact.is_some(),
                exact: exact.unwrap_or_else(|| span.id.clone()),
            }
        }
    }
}

/// The engine's order: the families as the issues always came (HTTP, Redis, cache), then the others; inside a family,
/// its systems as they first appear.
const ENGINE_ORDER: &[&str] = &["http", "redis", "cache", "datastore", "rpc", "messaging"];

/// Issues of every operation: SQL's (its own analysis: parameters, lookups by key, the ORM's hints), then every other
/// system's, one engine with each family's rules.
pub(crate) fn operation_issues(trace: &Trace, thresholds: &Thresholds) -> Vec<Issue> {
    let mut issues = sql_issues(trace, thresholds);
    let threshold = thresholds.n_plus_one.max(0) as usize;
    // (family, system) -> (group -> calls), in the order seen.
    let mut systems: Vec<(&'static str, String)> = Vec::new();
    let mut order: HashMap<(&'static str, String), Vec<String>> = HashMap::new();
    let mut groups: HashMap<(&'static str, String, String), Vec<Call<'_>>> = HashMap::new();
    for span in &trace.spans {
        let Some(operation) = operation(trace, span) else {
            continue;
        };
        // SQL has its own analysis; Redis commands under a cache operation or an enqueue are the cache's (or the
        // queue's) issue, on the layer the app fixes it on.
        if operation.family == "sql" || operation.via.is_some_and(|via| via != "direct") {
            continue;
        }
        let call = call_of(&operation, span);
        let system = (operation.family, operation.system.clone());
        if !order.contains_key(&system) {
            systems.push(system.clone());
        }
        let groups_of = order.entry(system.clone()).or_default();
        let at = (system.0, system.1.clone(), call.group.clone());
        if !groups.contains_key(&at) {
            groups_of.push(call.group.clone());
        }
        groups.entry(at).or_default().push(call);
    }
    for family in ENGINE_ORDER {
        for (_, system) in systems.iter().filter(|(of, _)| of == family) {
            let Some(rules) = rules(family, system) else {
                continue;
            };
            for group in &order[&(*family, system.clone())] {
                let calls = &groups[&(*family, system.clone(), group.clone())];
                issues.extend(group_issues(&rules, calls, group, thresholds, threshold));
            }
        }
    }
    issues
}

fn group_issues(
    rules: &Rules,
    calls: &[Call<'_>],
    group: &str,
    thresholds: &Thresholds,
    threshold: usize,
) -> Vec<Issue> {
    let mut issues = Vec::new();
    let label = &rules.label;
    let title = calls[0].title.as_str();
    let spans: Vec<&Span> = calls.iter().map(|call| call.span).collect();
    // An in-memory store's repeats are an issue only when they cost something together.
    if rules.cheap && !costly(&spans, thresholds.n_plus_one_min_ms) {
        return issues;
    }
    // The span's kind keeps the fingerprints of the issues found before operations.
    let key = format!("{}|{group}", spans[0].kind);
    // Only what project code makes is actionable, as with SQL.
    let Some(culprit_text) = culprit(&spans) else {
        return issues;
    };
    let key_culprit = culprit_key(Some(&culprit_text));
    let distinct = calls
        .iter()
        .map(|call| call.exact.as_str())
        .collect::<std::collections::HashSet<_>>()
        .len();
    if distinct >= threshold {
        issues.push(issue(
            issue_key("n+1", &[Some(&key), key_culprit.as_deref()]),
            "n+1",
            format!("N+1: {} similar {label} · {title}", spans.len()),
            Some(culprit_text.clone()),
            Some(rules.repeated_hint),
            spans.len(),
            spans.iter().map(|span| span.id.clone()).collect(),
        ));
    } else if let Some(duplicates_hint) = rules.duplicates_hint {
        let reads: Vec<&Call<'_>> = calls.iter().filter(|call| call.read).collect();
        let counts = reads
            .iter()
            .fold(HashMap::<&str, usize>::new(), |mut counts, call| {
                *counts.entry(call.exact.as_str()).or_default() += 1;
                counts
            });
        let repeated: Vec<&Span> = reads
            .iter()
            .filter(|call| counts[call.exact.as_str()] >= DUPLICATES_MIN)
            .map(|call| call.span)
            .collect();
        if !repeated.is_empty() {
            issues.push(issue(
                issue_key("duplicates", &[Some(&key), key_culprit.as_deref()]),
                "duplicates",
                format!("Duplicate {label}: {} identical · {title}", repeated.len()),
                Some(culprit_text.clone()),
                Some(duplicates_hint),
                repeated.len(),
                repeated.iter().map(|span| span.id.clone()).collect(),
            ));
        }
    }
    if let Some((kind, prefix)) = &rules.slow {
        let slow: Vec<&Span> = spans
            .iter()
            .copied()
            .filter(|span| span.duration >= thresholds.slow_http_ms * 1000)
            .collect();
        if !slow.is_empty() {
            let slowest = slow.iter().map(|span| span.duration).max().unwrap_or(0);
            issues.push(issue(
                issue_key(kind, &[Some(&key), key_culprit.as_deref()]),
                kind,
                format!("{prefix}: {} ms · {title}", milliseconds(slowest)),
                culprit(&slow),
                Some(SLOW_HTTP),
                slow.len(),
                slow.iter().map(|span| span.id.clone()).collect(),
            ));
        }
    }
    issues
}
