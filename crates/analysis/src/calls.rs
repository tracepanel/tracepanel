//! Operations: every call the app makes to another system, described one way. A SQL statement, a Redis command, a
//! cache operation, an HTTP or RPC call, a datastore command, a published message: each has a system, a family that
//! sets the rules, a target (the database, the instance, the host, the topic), an operation (the verb, command or
//! method) and a template (what repeats of it share). The store keeps them in one table, the console lists them one
//! way, and the issues come from one engine with one table of rules per family.
//!
//! The span's kind gives the family. The console groups a page by the system:
//! - `sql` for every SQL database (its vendor is the operation's `vendor`), `http` for outgoing HTTP calls, `cache` for
//!   a cache library's operations (its backend in `vendor`), `storage` for a file storage's calls (its system,
//!   `filesystem` or `s3`, in `vendor`), `llm` for calls to a model (its provider the target, its model the template,
//!   the model that answered in `vendor`);
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
    (storage::KIND, "storage"),
    (llm::KIND, "llm"),
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
    "storage",
    "llm",
];

/// The family of a span kind, or None for a span that isn't an operation.
pub fn family(kind: &str) -> Option<&'static str> {
    KINDS
        .iter()
        .find(|(name, _)| *name == kind)
        .map(|(_, family)| *family)
}

/// How titles name a system: its known spelling; a family's generic kind (a system that didn't name itself) by the
/// family; else its name as sent, capitalised.
pub fn display_name(system: &str) -> String {
    let name = match system {
        otel::GENERIC_RPC => "RPC",
        otel::GENERIC_DB => "Datastore",
        otel::GENERIC_MESSAGING => "Broker",
        "sql" => "Database",
        "cache" => "Cache",
        "storage" => "Storage",
        "llm" => "LLM",
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
        other => {
            let mut chars = other.chars();
            return chars.next().map_or_else(String::new, |first| {
                first.to_uppercase().chain(chars).collect()
            });
        }
    };
    name.to_owned()
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
    /// An LLM call: the tokens it took in and gave out.
    pub tokens: Option<(i64, i64)>,
    /// An LLM call: what it cost, estimated (`llm::cost`).
    pub cost: Option<f64>,
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
        tokens: None,
        cost: None,
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
        "storage" => {
            operation.target = storage::target(span);
            operation.op = storage::op(span);
            operation.statement = storage::path(span);
            operation.template =
                storage::path_template(&operation.op, operation.statement.as_deref());
            operation.vendor = text(attrs, "storage.system");
        }
        "llm" => {
            operation.target = llm::provider(span);
            operation.op = llm::operation(span);
            operation.template = llm::model(span);
            operation.vendor = llm::response_model(span);
            operation.tokens = llm::usage(attrs).map(|usage| (usage.input, usage.output));
            operation.cost = attrs.get(llm::COST).and_then(Value::as_f64);
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
            operation.params_hash = text(attrs, "db.params_hash");
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
    /// The slow-call issue, if the family has one.
    slow: Option<Slow>,
}

/// A family's slow-call issue: its kind, its title's prefix, its threshold and its hint.
struct Slow {
    kind: &'static str,
    prefix: String,
    threshold_ms: fn(&Thresholds) -> i64,
    hint: &'static str,
}

const SLOW_DATASTORE: &str = "Look at the query's plan in the datastore: an index on the fields it filters and sorts \
                              by, or a narrower query (fewer fields, a limit), usually makes it fast.";
const SLOW_RPC: &str = "The request waits for the other service: set a deadline, cache the answer, or make the call \
                        outside the request.";

/// What to do about repeats of one system's calls, where it has a way of its own (else the family's hint).
fn repeated_hint(system: &str) -> Option<&'static str> {
    Some(match system {
        "mongodb" => {
            "Fetch the documents in one query: an `$in` filter on the field (`{\"_id\": {\"$in\": ids}}`), or a \
             `$lookup` in an aggregation, instead of one `find` per item."
        }
        "elasticsearch" => {
            "Fetch the documents in one request: `_mget` for ids, `_msearch` for searches, instead of one per item."
        }
        "dynamodb" => {
            "Read the items in one `BatchGetItem` (up to 100 keys), and write them with `BatchWriteItem`, instead of \
             one call per item."
        }
        "cassandra" => {
            "Read the rows in one query (`IN` on the partition key), or run the statements concurrently, instead of \
             one after the other."
        }
        "kafka" => {
            "Produce the messages without waiting for each: send them in the loop and flush once after it, and the \
             producer batches them (`linger.ms`, `batch.size`)."
        }
        "rabbitmq" => {
            "Publish the messages on one channel without waiting for each confirm: publish in the loop, then wait for \
             the confirms once."
        }
        "sqs" => {
            "Send up to 10 messages at a time with `SendMessageBatch` instead of one `SendMessage` per item."
        }
        _ => return None,
    })
}

/// The fields a MongoDB query filters by: a filter's own keys, and those inside `$and`, `$or` and `$nor`.
fn filtered_fields(filter: &Value, fields: &mut Vec<String>) {
    let Some(object) = filter.as_object() else {
        return;
    };
    for (key, value) in object {
        if matches!(key.as_str(), "$and" | "$or" | "$nor") {
            for item in value.as_array().into_iter().flatten() {
                filtered_fields(item, fields);
            }
        } else if !key.starts_with('$') && !fields.contains(key) {
            fields.push(key.clone());
        }
    }
}

/// For a slow MongoDB query: the index its filter and sort need, as the shell creates it. MongoDB reads every
/// document of the collection (COLLSCAN in its plan) when no index covers the filter.
fn mongodb_index(span: &Span) -> Option<String> {
    let statement: Value = serde_json::from_str(&text(&span.attrs, "db.statement")?).ok()?;
    let collection = text(&span.attrs, "db.collection.name")?;
    let filter = statement
        .get("filter")
        .or_else(|| statement.get("query"))
        .or_else(|| statement["pipeline"].as_array()?.first()?.get("$match"))?;
    let mut fields = Vec::new();
    filtered_fields(filter, &mut fields);
    for key in statement["sort"]
        .as_object()
        .into_iter()
        .flat_map(|sort| sort.keys())
    {
        if !fields.contains(key) {
            fields.push(key.clone());
        }
    }
    if fields.is_empty() || fields == ["_id"] {
        return None;
    }
    let keys = fields
        .iter()
        .map(|field| format!("\"{field}\": 1"))
        .collect::<Vec<_>>()
        .join(", ");
    Some(format!(
        "{SLOW_DATASTORE} MongoDB reads every document of `{collection}` (COLLSCAN in `explain()`) when no index covers \
         the filter: `db.{collection}.createIndex({{{keys}}})`."
    ))
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
            slow: Some(Slow {
                kind: "slow-http",
                prefix: "Slow HTTP call".into(),
                threshold_ms: |thresholds| thresholds.slow_http_ms,
                hint: SLOW_HTTP,
            }),
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
                repeated_hint(system).unwrap_or(DATASTORE_REPEATED)
            },
            duplicates_hint: Some(if IN_MEMORY.contains(&system) {
                CACHE_DUPLICATES
            } else {
                DATASTORE_DUPLICATES
            }),
            cheap: IN_MEMORY.contains(&system),
            // A query in memory is never slow enough to matter; any other is, past `slow_sql_ms`, as SQL.
            slow: (!IN_MEMORY.contains(&system)).then(|| Slow {
                kind: "slow-call",
                prefix: format!("Slow {name} query"),
                threshold_ms: |thresholds| thresholds.slow_sql_ms,
                hint: SLOW_DATASTORE,
            }),
        },
        "messaging" => Rules {
            label: format!("{name} messages"),
            repeated_hint: repeated_hint(system).unwrap_or(MESSAGING_REPEATED),
            duplicates_hint: None,
            cheap: false,
            slow: None,
        },
        // A storage on this machine is cheap too: `storage::local` says which, per call.
        "storage" => Rules {
            label: "storage calls".into(),
            repeated_hint: storage::REPEATED,
            duplicates_hint: Some(storage::DUPLICATES),
            cheap: false,
            slow: None,
        },
        // Calls one by one in a loop (`llm::one_by_one`), the same prompt twice; a model's time is its own.
        "llm" => Rules {
            label: "LLM calls".into(),
            repeated_hint: "",
            duplicates_hint: Some(llm::DUPLICATES),
            cheap: false,
            slow: None,
        },
        "rpc" => Rules {
            label: format!("{name} calls"),
            repeated_hint: RPC_REPEATED,
            duplicates_hint: Some(RPC_DUPLICATES),
            cheap: false,
            slow: Some(Slow {
                kind: "slow-call",
                prefix: format!("Slow {name} call"),
                threshold_ms: |thresholds| thresholds.slow_http_ms,
                hint: SLOW_RPC,
            }),
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
        storage::KIND => storage_call(operation, span),
        llm::KIND => llm_call(operation, span),
        _ => {
            let what = format!("{} {}", operation.op, operation.template)
                .trim()
                .to_owned();
            let title = if operation.family == "rpc" {
                operation.template.clone()
            } else {
                what.clone()
            };
            // The exact query, when the span has it (a datastore's statement, with its parameters' hash when an SDK
            // keeps the values apart, as it does SQL's); else each call is its own: repeats count as an N+1, and no
            // two are known to be the same.
            let exact = operation
                .statement
                .clone()
                .filter(|statement| statement.contains(char::is_whitespace))
                .map(|statement| {
                    let params = operation.params_hash.as_deref().unwrap_or_default();
                    format!("{} {statement} {params}", operation.target)
                        .trim_end()
                        .to_owned()
                });
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

/// A storage call: a loop's calls look in one directory (`exists avatars/*`); the same call asks for the same file.
fn storage_call<'a>(operation: &Operation, span: &'a Span) -> Call<'a> {
    let title = format!("{} {}", operation.op, operation.template)
        .trim_end()
        .to_owned();
    let path = operation.statement.as_deref();
    Call {
        span,
        group: format!("{} {title}", operation.target),
        title,
        exact: format!(
            "{} {} {}",
            operation.target,
            operation.op,
            path.unwrap_or_default()
        ),
        read: path.is_some() && storage::read(&operation.op),
    }
}

/// An LLM call: a loop's calls ask one model for one operation; the same call sends the same prompt (known only when
/// the app captures the messages: else each call is its own).
fn llm_call<'a>(operation: &Operation, span: &'a Span) -> Call<'a> {
    let title = format!("{} {}", operation.op, operation.template)
        .trim_end()
        .to_owned();
    let prompt = llm::prompt(span);
    Call {
        span,
        group: format!("{} {title}", operation.target),
        title,
        read: prompt.is_some(),
        exact: prompt.unwrap_or_else(|| span.id.clone()),
    }
}

/// An HTTP call made for an LLM call (its API's request, one per attempt): the LLM call's, not an issue of its own. A
/// retry isn't a duplicate, and the model's time isn't a slow service.
fn inside_llm_call(trace: &Trace, span: &Span) -> bool {
    if span.kind != "http.client" {
        return false;
    }
    let mut parent = span.parent_id.as_deref();
    // A few levels up: an instrumentation may put a span of its own between them.
    for _ in 0..4 {
        let Some(found) = parent.and_then(|id| trace.spans.iter().find(|each| each.id == id))
        else {
            return false;
        };
        if found.kind == llm::KIND {
            return true;
        }
        parent = found.parent_id.as_deref();
    }
    false
}

/// An HTTP call recorded twice: a span under an `http.client` span for the same method and URL, as when two layers of
/// instrumentation each record one request (Next.js's fetch and undici under it). The outer span is the call.
fn nested_http_repeat(trace: &Trace, call: &Call<'_>) -> bool {
    if call.span.kind != "http.client" {
        return false;
    }
    let Some(parent_id) = call.span.parent_id.as_deref() else {
        return false;
    };
    trace
        .spans
        .iter()
        .find(|candidate| candidate.id == parent_id)
        .is_some_and(|parent| parent.kind == "http.client" && http_call(parent).exact == call.exact)
}

/// The engine's order:the families as the issues always came (HTTP, Redis, cache), then the others; inside a family,
/// its systems as they first appear.
const ENGINE_ORDER: &[&str] = &[
    "http",
    "redis",
    "cache",
    "datastore",
    "rpc",
    "messaging",
    "storage",
    "llm",
];

/// Issues of every operation: SQL's (its own analysis: parameters, lookups by key, the ORM's hints), then every other
/// system's, one engine with each family's rules.
pub(crate) fn operation_issues(trace: &Trace, thresholds: &Thresholds) -> Vec<Issue> {
    let mut issues = sql_issues(trace, thresholds);
    let threshold = thresholds.n_plus_one.max(0) as usize;
    // (family, system) -> (group -> calls), in the order seen.
    let mut systems: Vec<(&'static str, String)> = Vec::new();
    let mut order: HashMap<(&'static str, String), Vec<String>> = HashMap::new();
    let mut groups: HashMap<(&'static str, String, String), Vec<Call<'_>>> = HashMap::new();
    let has_llm = trace.spans.iter().any(|span| span.kind == llm::KIND);
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
        if nested_http_repeat(trace, &call) || (has_llm && inside_llm_call(trace, span)) {
            continue;
        }
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
    // An in-memory store's repeats, or a local storage's, are an issue only when they cost something together.
    let cheap = rules.cheap || spans.iter().all(|span| storage::local(span));
    if cheap && !costly(&spans, thresholds.n_plus_one_min_ms) {
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
    // An LLM call's repeats are a loop only one by one: at once they are batched, and an agent's turns can't be.
    let looped = spans[0].kind != llm::KIND || llm::one_by_one(&spans);
    if distinct >= threshold && looped {
        issues.push(issue(
            issue_key("n+1", &[Some(&key), key_culprit.as_deref()]),
            "n+1",
            format!("N+1: {} similar {label} · {title}", spans.len()),
            Some(culprit_text.clone()),
            Some(match spans[0].kind.as_str() {
                storage::KIND => storage::repeated_hint(spans[0]),
                llm::KIND => llm::repeated_hint(spans[0]),
                _ => rules.repeated_hint,
            }),
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
    if let Some(rule) = &rules.slow {
        let threshold_us = (rule.threshold_ms)(thresholds) * 1000;
        let slow: Vec<&Span> = spans
            .iter()
            .copied()
            .filter(|span| span.duration >= threshold_us)
            .collect();
        if let Some(slowest) = slow.iter().max_by_key(|span| span.duration) {
            let hint = (slowest.kind == "mongodb")
                .then(|| mongodb_index(slowest))
                .flatten();
            issues.push(issue(
                issue_key(rule.kind, &[Some(&key), key_culprit.as_deref()]),
                rule.kind,
                format!(
                    "{}: {} ms · {title}",
                    rule.prefix,
                    milliseconds(slowest.duration)
                ),
                culprit(&slow),
                Some(hint.as_deref().unwrap_or(rule.hint)),
                slow.len(),
                slow.iter().map(|span| span.id.clone()).collect(),
            ));
        }
    }
    issues
}

/// The first 16 hex of SHA-1: the ids the console's lists group by and link with.
fn short_sha1(text: &str) -> String {
    Sha1::digest(text.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()[..16]
        .to_owned()
}

pub fn query_fingerprint(statement: &str, alias: &str) -> String {
    short_sha1(&format!("{alias}|{statement}"))
}

/// An operation's id (`op:<key>` in search), the group a list of operations shows as one row. SQL's is its
/// statement's fingerprint key (`query:<key>`); every other system's is over "system|target|op|template|via": the same
/// Redis command made directly and under a cache operation are two rows.
pub fn call_key(operation: &Operation) -> String {
    if operation.family == "sql" {
        return query_fingerprint(&operation.template, &operation.target);
    }
    short_sha1(&format!(
        "{}|{}|{}|{}|{}",
        operation.system,
        operation.target,
        operation.op,
        operation.template,
        operation.via.unwrap_or_default()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_system_is_named_in_its_spelling_by_its_family_or_capitalised() {
        let names = ["mongodb", "rpc", "db", "messaging", "hbase", ""].map(display_name);

        assert_eq!(
            names,
            ["MongoDB", "RPC", "Datastore", "Broker", "Hbase", ""]
        );
    }

    #[test]
    fn a_query_s_key_is_16_hex_of_its_statement_and_alias() {
        let key = query_fingerprint("SELECT 1", "default");
        assert_eq!(key.len(), 16);
        assert_ne!(key, query_fingerprint("SELECT 1", "replica"));
    }

    #[test]
    fn an_operation_s_key_is_its_system_target_op_template_and_via() {
        let operation = |system: &str, target: &str, via: Option<&'static str>| Operation {
            system: system.into(),
            family: "http",
            target: target.into(),
            op: "GET".into(),
            template: "/users/{id}".into(),
            name: String::new(),
            statement: None,
            vendor: None,
            params_hash: None,
            via,
            hit: None,
            tokens: None,
            cost: None,
        };
        let key = call_key(&operation("http", "api.example.com", None));
        assert_eq!(key.len(), 16);
        assert_eq!(key, call_key(&operation("http", "api.example.com", None)));
        assert_ne!(key, call_key(&operation("http", "other.example.com", None)));
        assert_ne!(key, call_key(&operation("grpc", "api.example.com", None)));
        assert_ne!(
            key,
            call_key(&operation("http", "api.example.com", Some("cache")))
        );
    }
}
