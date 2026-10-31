//! Spans, as exporters send them, into the agent's traces.
//!
//! An exporter sends spans in batches as they end: a request's database calls before the request itself, a long
//! trace over several batches. Spans wait here per W3C trace and service. A trace holds one service's work for one
//! entry into it (a request it served, a task it took, a command it ran): the spans under a local root, the span
//! whose parent is in another process or nowhere. A trace goes out once its spans stop coming (`QUIET`) and its root
//! is an entry (a server or consumer span, or one with no parent), or after `WAIT` whatever came. Its spans stay a
//! while (`LINGER`): a late one sends the trace again, whole, under the same id, and the agent writes it over.
//!
//! Ids are made from the W3C ones, so a trace sent again is the same trace: a span's from the trace id's high half and
//! its span id, a trace's from the trace id's low half and its root's span id. `w3c.*` attributes keep the W3C ids,
//! what links one service's trace to the one that called it.
//!
//! A span's events: an `exception` is the trace's error, a query sqlx logged a `sql` span of its own (Rust's
//! `tracing` events, which tracing-opentelemetry exports as events of the span they happened in), and any other a log
//! record of the trace, as the SDKs send theirs.

use crate::proto::{
    AnyValue, Event, ExportTraceServiceRequest, FLAG_HAS_IS_REMOTE, FLAG_IS_REMOTE, KeyValue,
    STATUS_ERROR, Span, Value as Any, span_kind,
};
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// How long a trace's spans must have stopped coming before it goes out.
pub const QUIET: Duration = Duration::from_secs(2);
/// The longest a trace waits for its root: then it goes out with what came.
pub const WAIT: Duration = Duration::from_secs(30);
/// How long a sent trace's spans are kept for a late one.
pub const LINGER: Duration = Duration::from_secs(60);
/// The most spans kept waiting: past it, the oldest traces go out as they are.
const MAX_SPANS: usize = 200_000;

/// A span as received, with what its batch says about where it ran.
struct Got {
    span: Span,
    scope: Arc<str>,
    resource: Arc<Map<String, Value>>,
}

struct Bucket {
    spans: HashMap<u64, Got>,
    /// When a span last came.
    last: Instant,
    /// When the first span not yet sent came: unset once sent.
    pending_since: Option<Instant>,
}

/// The spans waiting per (W3C trace id, service).
#[derive(Default)]
pub struct Assembler {
    buckets: HashMap<(u128, String), Bucket>,
}

fn id64(bytes: &[u8]) -> Option<u64> {
    Some(u64::from_be_bytes(bytes.try_into().ok()?))
}

fn id128(bytes: &[u8]) -> Option<u128> {
    Some(u128::from_be_bytes(bytes.try_into().ok()?))
}

/// Crockford's base32, as a ULID spells its 128 bits.
fn ulid(value: u128) -> String {
    const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    (0..26)
        .map(|at| char::from(ALPHABET[((value >> (125 - 5 * at)) & 31) as usize]))
        .collect()
}

fn span_id(trace: u128, span: u64) -> String {
    ulid((trace >> 64) << 64 | u128::from(span))
}

fn trace_id(trace: u128, root: u64) -> String {
    ulid((trace & u128::from(u64::MAX)) << 64 | u128::from(root))
}

fn any(value: &AnyValue) -> Value {
    match &value.value {
        Some(Any::String(text)) => Value::from(text.as_str()),
        Some(Any::Bool(flag)) => Value::from(*flag),
        Some(Any::Int(number)) => Value::from(*number),
        Some(Any::Double(number)) => Value::from(*number),
        Some(Any::Array(array)) => Value::Array(array.values.iter().map(any).collect()),
        // A map isn't an attribute value here: its JSON, as text.
        Some(Any::KvList(map)) => Value::from(Value::Object(attributes(&map.values)).to_string()),
        Some(Any::Bytes(bytes)) => Value::from(
            bytes
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>(),
        ),
        None => Value::Null,
    }
}

fn attributes(pairs: &[KeyValue]) -> Map<String, Value> {
    pairs
        .iter()
        .map(|pair| {
            (
                pair.key.clone(),
                pair.value.as_ref().map_or(Value::Null, any),
            )
        })
        .collect()
}

fn text<'a>(attrs: &'a Map<String, Value>, keys: &[&str]) -> Option<&'a str> {
    keys.iter().find_map(|key| attrs.get(*key)?.as_str())
}

fn service(resource: &Map<String, Value>) -> String {
    text(resource, &["service.name"])
        .unwrap_or("unknown_service")
        .to_owned()
}

impl Assembler {
    /// The spans of an export, waiting for the rest of their traces.
    pub fn add(&mut self, request: ExportTraceServiceRequest, now: Instant) {
        for resource_spans in request.resource_spans {
            let resource = Arc::new(attributes(
                &resource_spans
                    .resource
                    .map(|resource| resource.attributes)
                    .unwrap_or_default(),
            ));
            let name = service(&resource);
            for scope_spans in resource_spans.scope_spans {
                let scope: Arc<str> = scope_spans
                    .scope
                    .map(|scope| scope.name)
                    .unwrap_or_default()
                    .into();
                for span in scope_spans.spans {
                    let (Some(trace), Some(id)) = (id128(&span.trace_id), id64(&span.span_id))
                    else {
                        continue;
                    };
                    let bucket = self
                        .buckets
                        .entry((trace, name.clone()))
                        .or_insert_with(|| Bucket {
                            spans: HashMap::new(),
                            last: now,
                            pending_since: None,
                        });
                    bucket.last = now;
                    bucket.pending_since.get_or_insert(now);
                    bucket.spans.insert(
                        id,
                        Got {
                            span,
                            scope: scope.clone(),
                            resource: resource.clone(),
                        },
                    );
                }
            }
        }
    }

    /// The traces ready to go out, as trace documents; traces sent long enough ago are forgotten.
    pub fn ready(&mut self, now: Instant) -> Vec<Value> {
        let crowded = self
            .buckets
            .values()
            .map(|bucket| bucket.spans.len())
            .sum::<usize>()
            > MAX_SPANS;
        let mut docs = Vec::new();
        for ((trace, _), bucket) in &mut self.buckets {
            let Some(since) = bucket.pending_since else {
                continue;
            };
            let settled = now.duration_since(bucket.last) >= QUIET && has_entry(bucket);
            if settled || now.duration_since(since) >= WAIT || crowded {
                docs.extend(traces(*trace, bucket));
                bucket.pending_since = None;
            }
        }
        self.buckets.retain(|_, bucket| {
            bucket.pending_since.is_some() || now.duration_since(bucket.last) < LINGER
        });
        docs
    }
}

/// The span whose parent is in another process or nowhere: where its trace starts in this service.
fn root_of(bucket: &Bucket, mut id: u64) -> u64 {
    // A loop in broken parent ids ends here rather than never.
    for _ in 0..bucket.spans.len() {
        let parent = id64(&bucket.spans[&id].span.parent_span_id);
        match parent.filter(|parent| bucket.spans.contains_key(parent)) {
            Some(parent) if !remote(&bucket.spans[&id].span) => id = parent,
            _ => break,
        }
    }
    id
}

/// The exporter says the span's parent is in another process.
fn remote(span: &Span) -> bool {
    span.flags & FLAG_HAS_IS_REMOTE != 0 && span.flags & FLAG_IS_REMOTE != 0
}

/// A root that is where work came in: a server or consumer span, or one with no parent at all.
fn entry(span: &Span) -> bool {
    matches!(span.kind, 2 | 5) || span.parent_span_id.iter().all(|byte| *byte == 0) || remote(span)
}

fn has_entry(bucket: &Bucket) -> bool {
    bucket
        .spans
        .keys()
        .any(|id| entry(&bucket.spans[&root_of(bucket, *id)].span))
}

/// The bucket's traces: one per local root, with the spans under it.
fn traces(trace: u128, bucket: &Bucket) -> Vec<Value> {
    let mut groups: HashMap<u64, Vec<u64>> = HashMap::new();
    for id in bucket.spans.keys() {
        groups.entry(root_of(bucket, *id)).or_default().push(*id);
    }
    groups
        .into_iter()
        .filter(|(root, members)| !nobodys(&bucket.spans[root], members, bucket))
        .map(|(root, members)| document(trace, &bucket.spans[&root], root, &members, bucket))
        .collect()
}

/// A trace that is nobody's work, left out: a browser's CORS preflight (which the server answers before the request
/// it asks about, and which the SDKs leave out too), and Apollo Router's own work outside a request (its `starting`, a
/// schema reloaded), an internal root of its own scope, and so Hive Gateway's. `members`: the root's trace's spans.
fn nobodys(root: &Got, members: &[u64], bucket: &Bucket) -> bool {
    let routers_own = &*root.scope == "apollo-router" && root.span.kind == 1;
    // Hive Gateway's (and GraphQL Mesh's) start, its schema loaded under it, or a schema loaded again: under its
    // default tracer, or another one by the schema's span (`gateway.schema`, which says whether it changed).
    let schema = |span: &Span| {
        span.name == "gateway.schema"
            && span
                .attributes
                .iter()
                .any(|pair| pair.key == "gateway.schema.changed")
    };
    let gateways_own = root.span.kind == 1
        && match root.span.name.as_str() {
            "gateway.initialization" => {
                &*root.scope == "gateway" || members.iter().any(|id| schema(&bucket.spans[id].span))
            }
            "gateway.schema" => &*root.scope == "gateway" || schema(&root.span),
            _ => false,
        };
    routers_own || gateways_own || preflight(root, members.len() == 1)
}

/// A CORS preflight: an `OPTIONS` request served that asks for another method (its `Access-Control-Request-Method`
/// header, when the instrumentation recorded it). Most exports carry no request headers: then an `OPTIONS` that did
/// no work of its own, no span under it, no error and no status but a 2xx one, is taken for one. An `OPTIONS` that did
/// work (a handler that queried, failed or answered otherwise) is a request as any other.
fn preflight(root: &Got, alone: bool) -> bool {
    let mut attrs = attributes(&root.span.attributes);
    let served = tower_request(&mut attrs) || root.span.kind == 2;
    if !served || text(&attrs, &["http.request.method", "http.method"]) != Some("OPTIONS") {
        return false;
    }
    if asks_for_method(&attrs) {
        return true;
    }
    let failed = root
        .span
        .status
        .as_ref()
        .is_some_and(|status| status.code == STATUS_ERROR);
    let status = ["http.response.status_code", "http.status_code"]
        .iter()
        .find_map(|key| count(&attrs, key))
        .or_else(|| tower_status(&root.span));
    alone && !failed && status.is_none_or(|status| (200..300).contains(&status))
}

/// The request's `Access-Control-Request-Method` header, recorded as OpenTelemetry names a request header
/// (`http.request.header.access-control-request-method`, a list of values; older instrumentations wrote `_` for `-`).
fn asks_for_method(attrs: &Map<String, Value>) -> bool {
    attrs.iter().any(|(key, value)| {
        let named = key
            .strip_prefix("http.request.header.")
            .is_some_and(|name| {
                name.replace('_', "-")
                    .eq_ignore_ascii_case("access-control-request-method")
            });
        let given = match value {
            Value::String(text) => !text.is_empty(),
            Value::Array(values) => values
                .iter()
                .any(|value| value.as_str().is_some_and(|text| !text.is_empty())),
            _ => false,
        };
        named && given
    })
}

fn micros(nanos: u64) -> i64 {
    i64::try_from(nanos / 1000).unwrap_or(i64::MAX)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// What came in, from the root's kind and attributes: a request served (HTTP, or an RPC call such as gRPC), a task
/// taken, or a command run.
fn kind_of(span_kind: i32, attrs: &Map<String, Value>) -> (&'static str, &'static str) {
    let http = text(attrs, &["http.request.method", "http.method"]).is_some();
    if span_kind == 2 && http {
        return ("http", "web");
    }
    if span_kind == 2 && text(attrs, &["rpc.system"]).is_some() {
        return ("rpc", "web");
    }
    let processing = matches!(
        text(attrs, &["messaging.operation.type", "messaging.operation"]),
        Some("process" | "receive")
    );
    if span_kind == 5 || processing {
        return ("task", "worker");
    }
    if span_kind == 2 {
        return ("http", "web");
    }
    ("command", "command")
}

/// Instrumentation scopes, as OpenTelemetry's libraries and agents name them (lowercased), and the framework each
/// one means: the first that matches names the trace's.
const FRAMEWORKS: &[(&str, &str)] = &[
    // The JVM.
    ("spring-webmvc", "Spring"),
    ("spring-webflux", "Spring"),
    ("ktor", "Ktor"),
    ("micronaut", "Micronaut"),
    ("quarkus", "Quarkus"),
    ("vertx-web", "Vert.x"),
    ("javalin", "Javalin"),
    ("helidon", "Helidon"),
    ("dropwizard", "Dropwizard"),
    ("io.opentelemetry.play", "Play"),
    ("grails", "Grails"),
    // Python.
    ("instrumentation.django", "Django"),
    ("instrumentation.fastapi", "FastAPI"),
    ("instrumentation.flask", "Flask"),
    ("instrumentation.starlette", "Starlette"),
    ("instrumentation.falcon", "Falcon"),
    ("instrumentation.tornado", "Tornado"),
    ("instrumentation.pyramid", "Pyramid"),
    ("instrumentation.aiohttp_server", "aiohttp"),
    // Node.js.
    ("instrumentation-express", "Express"),
    ("instrumentation-nestjs-core", "NestJS"),
    ("instrumentation-fastify", "Fastify"),
    ("@fastify/otel", "Fastify"),
    ("instrumentation-koa", "Koa"),
    ("instrumentation-hapi", "hapi"),
    ("@hono/otel", "Hono"),
    ("next.js", "Next.js"),
    // Go.
    ("otelgin", "Gin"),
    ("gin-gonic", "Gin"),
    ("otelecho", "Echo"),
    ("labstack/echo", "Echo"),
    ("gofiber", "Fiber"),
    ("gorilla/mux", "gorilla/mux"),
    // Ruby.
    ("instrumentation::rails", "Rails"),
    ("instrumentation::sinatra", "Sinatra"),
    // PHP.
    ("php.laravel", "Laravel"),
    ("php.symfony", "Symfony"),
    ("php.slim", "Slim"),
    // .NET.
    ("aspnetcore", "ASP.NET Core"),
    // Elixir.
    ("opentelemetry_phoenix", "Phoenix"),
    // Rust.
    ("actix", "Actix Web"),
    ("axum", "Axum"),
    ("rocket", "Rocket"),
    // Swift.
    ("vapor", "Vapor"),
];

/// The framework an instrumentation scope belongs to, if it is one's.
fn framework(scope: &str) -> Option<&'static str> {
    let scope = scope.to_lowercase();
    FRAMEWORKS
        .iter()
        .find(|(part, _)| scope.contains(part))
        .map(|(_, name)| *name)
}

/// The first of `from` the attributes have, as `to`.
fn copy(out: &mut Map<String, Value>, attrs: &Map<String, Value>, to: &str, from: &[&str]) {
    if let Some(value) = from.iter().find_map(|key| attrs.get(*key)) {
        out.insert(to.into(), value.clone());
    }
}

/// The trace's own attributes, as the SDKs name them: where it ran, and what came in.
fn trace_attrs(
    root: &Got,
    attrs: &Map<String, Value>,
    kind: &str,
    role: &str,
) -> Map<String, Value> {
    let mut out = Map::new();
    out.insert("service.name".into(), Value::from(service(&root.resource)));
    out.insert("service.role".into(), Value::from(role));
    for key in [
        "telemetry.sdk.language",
        "process.runtime.name",
        "process.runtime.version",
        "service.version",
    ] {
        if let Some(value) = root.resource.get(key) {
            out.insert(key.into(), value.clone());
        }
    }
    if kind == "http" {
        copy(
            &mut out,
            attrs,
            "http.method",
            &["http.request.method", "http.method", "rpc.method"],
        );
        copy(
            &mut out,
            attrs,
            "http.route",
            &["http.route", "rpc.service"],
        );
        copy(
            &mut out,
            attrs,
            "http.status_code",
            &["http.response.status_code", "http.status_code"],
        );
        copy(&mut out, attrs, "user.id", &["enduser.id", "user.id"]);
        let path = text(attrs, &["url.path", "http.target"])
            .map(|path| path.split('?').next().unwrap_or(path));
        if let Some(path) = path {
            out.insert("http.path".into(), Value::from(path));
        }
        if let Some((operation, name)) = graphql_operation(&root.span, attrs) {
            out.insert("graphql.operation.type".into(), Value::from(operation));
            out.insert("graphql.operation.name".into(), Value::from(name));
        }
    }
    if kind == "rpc" {
        for key in [
            "rpc.system",
            "rpc.service",
            "rpc.method",
            "rpc.grpc.status_code",
        ] {
            copy(&mut out, attrs, key, &[key]);
        }
        copy(&mut out, attrs, "user.id", &["enduser.id", "user.id"]);
    }
    if kind == "task" {
        copy(&mut out, attrs, "task.system", &["messaging.system"]);
        copy(
            &mut out,
            attrs,
            "task.queue",
            &["messaging.destination.name", "messaging.source.name"],
        );
        // The broker it took the task from: the services map's arrow from the broker to the worker.
        for key in ["messaging.system", "server.address", "server.port"] {
            copy(&mut out, attrs, key, &[key]);
        }
    }
    out.insert("w3c.trace_id".into(), Value::from(hex(&root.span.trace_id)));
    if !root.span.parent_span_id.iter().all(|byte| *byte == 0) {
        out.insert(
            "w3c.parent_span_id".into(),
            Value::from(hex(&root.span.parent_span_id)),
        );
    }
    out
}

fn trace_name(root: &Span, attrs: &Map<String, Value>, kind: &str) -> String {
    if kind == "rpc"
        && let (Some(service), Some(method)) =
            (text(attrs, &["rpc.service"]), text(attrs, &["rpc.method"]))
    {
        return format!("{service}/{method}");
    }
    if kind != "http" {
        return root.name.clone();
    }
    if let Some((operation, name)) = graphql_operation(root, attrs) {
        return format!("GraphQL {operation} {name}");
    }
    let method = text(attrs, &["http.request.method", "http.method"]);
    let target = text(attrs, &["http.route", "url.path", "http.target"]);
    match (method, target) {
        (Some(method), Some(target)) => {
            format!("{method} {}", target.split('?').next().unwrap_or(target))
        }
        _ => root.name.clone(),
    }
}

/// A GraphQL server's operation, as its type and name: from the conventions' `graphql.operation.*` (Cosmo Router's
/// `wg.operation.*`), or from a span named after it (Apollo Router's `query Books`). The trace is named after it, as
/// the SDKs name theirs.
fn graphql_operation(root: &Span, attrs: &Map<String, Value>) -> Option<(String, String)> {
    if let (Some(operation), Some(name)) = (
        text(attrs, &["graphql.operation.type", "wg.operation.type"]),
        text(attrs, &["graphql.operation.name", "wg.operation.name"]),
    ) {
        return Some((operation.to_owned(), name.to_owned()));
    }
    let (operation, name) = root.name.split_once(' ')?;
    let named = !name.is_empty() && name.chars().all(|c| c.is_alphanumeric() || c == '_');
    (matches!(operation, "query" | "mutation" | "subscription") && named)
        .then(|| (operation.to_owned(), name.to_owned()))
}

/// `file:line in function`, from the conventions' `code.*` attributes, as the SDKs write `code.origin`.
fn origin(attrs: &Map<String, Value>) -> Option<String> {
    let file = text(attrs, &["code.file.path", "code.filepath"])?;
    let line = ["code.line.number", "code.lineno"]
        .iter()
        .find_map(|key| attrs.get(*key)?.as_i64());
    let function = text(attrs, &["code.function.name", "code.function"]);
    let place = line.map_or(file.to_owned(), |line| format!("{file}:{line}"));
    Some(function.map_or(place.clone(), |function| format!("{place} in {function}")))
}

/// Grafbase Gateway's request to a subgraph: an internal span (it names no kind) with a method and a URL, the span
/// whose id the subgraph gets.
fn grafbase_request(got: &Got) -> bool {
    let attrs = attributes(&got.span.attributes);
    &*got.scope == "grafbase"
        && got.span.kind == 1
        && text(&attrs, &["http.request.method"]).is_some()
        && text(&attrs, &["url.full"]).is_some()
}

fn span_doc(trace: u128, got: &Got, parent: Option<String>, bucket: &Bucket) -> Value {
    let span = &got.span;
    let mut attrs = attributes(&span.attributes);
    attrs.insert("otel.span_kind".into(), Value::from(span_kind(span.kind)));
    attrs.insert("otel.scope".into(), Value::from(&*got.scope));
    // A span a Rust dependency made (reqwest-tracing's call) is where the app's code called it from: the nearest
    // span up that the app made, as a query sqlx logged is.
    let in_library = text(&attrs, &["code.file.path", "code.filepath"]).is_some_and(library);
    let origin = if in_library {
        id64(&span.parent_span_id)
            .filter(|parent| !remote(span) && bucket.spans.contains_key(parent))
            .and_then(|parent| app_origin(bucket, parent))
    } else {
        origin(&attrs)
    };
    if let Some(origin) = origin {
        attrs.entry("code.origin").or_insert(Value::from(origin));
    }
    // A call that carries the trace on (HTTP, RPC, a message): the id the service it reaches sees as its parent. An
    // HTTP call may name only its URL or its peer (Apollo Router's requests to its subgraphs carry no method).
    let carries = [
        "http.request.method",
        "http.method",
        "url.full",
        "http.url",
        "rpc.system",
        "messaging.system",
    ]
    .iter()
    .any(|key| attrs.contains_key(*key));
    if (matches!(span.kind, 3 | 4) || grafbase_request(got)) && carries {
        attrs.insert("w3c.span_id".into(), Value::from(hex(&span.span_id)));
    }
    let failed = span
        .status
        .as_ref()
        .is_some_and(|status| status.code == STATUS_ERROR);
    json!({
        "id": span_id(trace, id64(&span.span_id).unwrap_or(0)),
        "parent_id": parent,
        "kind": "otel",
        "name": span.name,
        "start": micros(span.start_time_unix_nano),
        "duration": micros(span.end_time_unix_nano.saturating_sub(span.start_time_unix_nano)),
        "status": if failed { "error" } else { "ok" },
        "attrs": attrs,
    })
}

/// A span's `exception` events, as the trace's errors.
fn errors(trace: u128, got: &Got, on_root: bool) -> Vec<Value> {
    let failed = got
        .span
        .status
        .as_ref()
        .is_some_and(|status| status.code == STATUS_ERROR);
    got.span
        .events
        .iter()
        .filter(|event| event.name == "exception")
        .map(|event| {
            let attrs = attributes(&event.attributes);
            json!({
                "span_id": if on_root { None } else { Some(span_id(trace, id64(&got.span.span_id).unwrap_or(0))) },
                "time": micros(event.time_unix_nano),
                "type": text(&attrs, &["exception.type"]).unwrap_or("Exception"),
                "message": text(&attrs, &["exception.message"]).unwrap_or_default(),
                "handled": !failed,
                "frames": [],
                "chain": [],
            })
        })
        .collect()
}

/// tower-http's `TraceLayer` request span (a Rust app's, through tracing-opentelemetry), read as the conventions'
/// request: a span with `method` and `uri` and none of the conventions' HTTP attributes, exported as an internal span
/// unless the app sets `otel.kind`. Its method and path are set as `http.request.method` and `url.path`, so it is
/// named and listed as a request served. Whether it is one.
fn tower_request(attrs: &mut Map<String, Value>) -> bool {
    if text(attrs, &["http.request.method", "http.method"]).is_some() {
        return false;
    }
    let (Some(method), Some(uri)) = (text(attrs, &["method"]), text(attrs, &["uri"])) else {
        return false;
    };
    let method_like = !method.is_empty() && method.bytes().all(|byte| byte.is_ascii_uppercase());
    let Some(path) = uri_path(uri).filter(|_| method_like) else {
        return false;
    };
    let (method, path) = (Value::from(method), Value::from(path));
    attrs.insert("http.request.method".into(), method);
    attrs.insert("url.path".into(), path);
    true
}

/// A request's URI without its query: `/users/7?tab=1` as `/users/7`, `http://host/users/7` as `/users/7`.
fn uri_path(uri: &str) -> Option<&str> {
    let rest = match uri.split_once("://") {
        Some((_, after)) => after.find('/').map_or("/", |at| &after[at..]),
        None => uri,
    };
    let path = rest.split(['?', '#']).next().unwrap_or_default();
    path.starts_with('/').then_some(path)
}

/// The status code tower-http's `TraceLayer` logged as the request finished (its `on_response` event's `status`).
fn tower_status(span: &Span) -> Option<i64> {
    span.events.iter().rev().find_map(|event| {
        let attrs = attributes(&event.attributes);
        if text(&attrs, &["target"]) != Some("tower_http::trace::on_response") {
            return None;
        }
        match attrs.get("status")? {
            Value::Number(number) => number.as_i64(),
            Value::String(number) => number.parse().ok(),
            _ => None,
        }
    })
}

/// What a span event is to the trace.
enum Happened {
    /// An `exception`: the trace's error (`errors`).
    Exception,
    /// A query sqlx logged when it was done (target `sqlx::query`): a `sql` span.
    Query,
    /// tower-http's `TraceLayer` saying a request started or finished: the request span itself says so.
    Lifecycle,
    /// Anything else: a log record.
    Log,
}

fn happened(event: &Event, attrs: &Map<String, Value>) -> Happened {
    let target = text(attrs, &["target"]).unwrap_or_default();
    if event.name == "exception" {
        Happened::Exception
    } else if target == "sqlx::query" {
        Happened::Query
    } else if target
        .strip_prefix("tower_http::trace::")
        .is_some_and(|step| {
            matches!(
                step,
                "on_request" | "on_response" | "on_body_chunk" | "on_eos"
            )
        })
    {
        Happened::Lifecycle
    } else {
        Happened::Log
    }
}

/// A span's events, as the trace's `sql` spans and log records (its exceptions are `errors`).
fn events(
    trace: u128,
    id: u64,
    root_id: u64,
    bucket: &Bucket,
    spans: &mut Vec<Value>,
    logs: &mut Vec<Value>,
) {
    let got = &bucket.spans[&id];
    if got.span.events.is_empty() {
        return;
    }
    // What a query needs of the span, read once it has one.
    let mut owner: Option<(Map<String, Value>, Option<String>)> = None;
    for (index, event) in got.span.events.iter().enumerate() {
        if event.name == "exception" {
            continue;
        }
        let attrs = attributes(&event.attributes);
        match happened(event, &attrs) {
            Happened::Exception | Happened::Lifecycle => {}
            Happened::Query => {
                let (owner_attrs, site) = owner.get_or_insert_with(|| {
                    (attributes(&got.span.attributes), app_origin(bucket, id))
                });
                let context = [&attrs, &*owner_attrs, &*got.resource];
                spans.push(query(trace, id, index, event, &attrs, &context, site));
            }
            Happened::Log => {
                let span = (id != root_id).then(|| span_id(trace, id));
                logs.push(log(event, attrs, span, &got.scope));
            }
        }
    }
}

/// A Rust source file of a dependency (crates.io's registry, a git dependency) or of the standard library, as
/// `file!()` spells them: not the app's own code.
fn library(file: &str) -> bool {
    const FOLDERS: [&str; 4] = [
        "/registry/src/",
        "\\registry\\src\\",
        "/git/checkouts/",
        "\\git\\checkouts\\",
    ];
    FOLDERS.iter().any(|folder| file.contains(folder)) || file.starts_with("/rustc/")
}

/// A dependency's file from its crate's folder on (`tower-http-0.7.1/src/trace/make_span.rs`), the app's as it is.
fn short_path(file: &str) -> &str {
    ["/registry/src/", "/git/checkouts/"]
        .iter()
        .find_map(|marker| {
            let (_, after) = file.split_once(marker)?;
            after.split_once('/').map(|(_, path)| path)
        })
        .unwrap_or(file)
}

/// Where in the app a query ran: the nearest span up from the one it happened in that the app's own code made (a
/// handler under `#[tracing::instrument]`), as `file:line in name`. sqlx logs its queries from its own code, so the
/// event says nothing of it.
fn app_origin(bucket: &Bucket, mut id: u64) -> Option<String> {
    for _ in 0..bucket.spans.len() {
        let got = &bucket.spans[&id];
        let attrs = attributes(&got.span.attributes);
        if let Some(file) = text(&attrs, &["code.file.path", "code.filepath"])
            && !library(file)
        {
            let line = ["code.line.number", "code.lineno"]
                .iter()
                .find_map(|key| attrs.get(*key)?.as_i64());
            let place = line.map_or(file.to_owned(), |line| format!("{file}:{line}"));
            let function =
                text(&attrs, &["code.function.name", "code.function"]).unwrap_or(&got.span.name);
            return Some(format!("{place} in {function}"));
        }
        let parent = id64(&got.span.parent_span_id)?;
        if remote(&got.span) || !bucket.spans.contains_key(&parent) {
            return None;
        }
        id = parent;
    }
    None
}

/// A number an exporter may send as text: tracing-opentelemetry records a `u64` field by its `Debug`.
fn count(attrs: &Map<String, Value>, key: &str) -> Option<i64> {
    match attrs.get(key)? {
        Value::Number(number) => number.as_i64(),
        Value::String(number) => number.parse().ok(),
        _ => None,
    }
}

/// A span id of its own for a span made from an event: the same each time the trace is sent.
fn event_span_id(span: u64, index: usize) -> u64 {
    // SplitMix64's finalizer over the span's id and the event's place in it.
    let mut mixed = span ^ (index as u64 + 1).wrapping_mul(0x9e37_79b9_7f4a_7c15);
    mixed = (mixed ^ (mixed >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    mixed = (mixed ^ (mixed >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    mixed ^ (mixed >> 31)
}

/// A query sqlx logged, as the client span an instrumented driver would have sent: it ended when it was logged and
/// took `elapsed_secs`. Its statement is `db.statement` (empty when the SQL is four words or fewer) or the `summary`.
/// sqlx doesn't name its database: the system is the span's or the app's `db.system.name` when either has one, else
/// `other_sql`, any SQL database. Its call site is the app's (`app_origin`), never sqlx's own code.
fn query(
    trace: u128,
    owner: u64,
    index: usize,
    event: &Event,
    attrs: &Map<String, Value>,
    context: &[&Map<String, Value>],
    call_site: &Option<String>,
) -> Value {
    let summary = text(attrs, &["summary"]).unwrap_or_default();
    let statement = text(attrs, &["db.statement"])
        .map(str::trim)
        .filter(|sql| !sql.is_empty())
        .unwrap_or_else(|| summary.trim_end_matches(" …"));
    let system = context
        .iter()
        .find_map(|attrs| text(attrs, &["db.system.name", "db.system"]))
        .unwrap_or("other_sql");
    let elapsed = attrs
        .get("elapsed_secs")
        .and_then(Value::as_f64)
        .filter(|secs| secs.is_finite() && *secs >= 0.0)
        .map_or(0, |secs| (secs * 1e9) as u64);
    let mut out = Map::new();
    out.insert("db.system.name".into(), Value::from(system));
    out.insert("db.query.text".into(), Value::from(statement));
    if let Some(rows) = count(attrs, "rows_returned") {
        out.insert("db.response.returned_rows".into(), Value::from(rows));
    }
    if let Some(rows) = count(attrs, "rows_affected") {
        out.insert("db.response.affected_rows".into(), Value::from(rows));
    }
    out.insert("otel.span_kind".into(), Value::from("client"));
    out.insert("otel.scope".into(), Value::from("sqlx"));
    if let Some(site) = call_site {
        out.insert("code.origin".into(), Value::from(site.as_str()));
    }
    let start = event.time_unix_nano.saturating_sub(elapsed);
    json!({
        "id": span_id(trace, event_span_id(owner, index)),
        "parent_id": span_id(trace, owner),
        "kind": "otel",
        "name": summary,
        "start": micros(start),
        "duration": micros(elapsed),
        "status": "ok",
        "attrs": out,
    })
}

/// A level as the SDKs write it: `tracing`'s `TRACE`…`ERROR`, or an OpenTelemetry severity's text.
fn level(attrs: &Map<String, Value>) -> &'static str {
    let level = text(attrs, &["level", "log.severity", "severity"]).unwrap_or("INFO");
    match level.to_ascii_lowercase().as_str() {
        "trace" | "debug" => "debug",
        "warn" | "warning" => "warning",
        "error" => "error",
        "fatal" | "critical" => "critical",
        _ => "info",
    }
}

/// A span event as a log record of the trace: its level from `level`, its logger the event's `target` (a Rust
/// module, where `tracing` logged it) or else the span's instrumentation, its message the event's name
/// (tracing-opentelemetry names an event after its `message`). An event logged with no message (`event
/// src/main.rs:12`, as `tracing` names it) reads as its fields. Its other attributes are kept as `extra.*`, where it
/// was logged as `code.origin`.
fn log(event: &Event, attrs: Map<String, Value>, span: Option<String>, scope: &str) -> Value {
    let mut out = Map::new();
    if let Some(file) = text(&attrs, &["code.file.path", "code.filepath"]) {
        let line = ["code.line.number", "code.lineno"]
            .iter()
            .find_map(|key| attrs.get(*key)?.as_i64());
        let file = short_path(file);
        let place = line.map_or(file.to_owned(), |line| format!("{file}:{line}"));
        out.insert("code.origin".into(), Value::from(place));
    }
    let level = level(&attrs);
    let logger = text(&attrs, &["target"])
        .unwrap_or(if scope.is_empty() { "otel" } else { scope })
        .to_owned();
    let mut fields = Vec::new();
    for (key, value) in attrs {
        if matches!(key.as_str(), "level" | "target" | "message") || key.starts_with("code.") {
            continue;
        }
        let shown = value
            .as_str()
            .map_or_else(|| value.to_string(), str::to_owned);
        fields.push(format!("{key}={shown}"));
        out.insert(format!("extra.{key}"), value);
    }
    let unnamed = event.name.starts_with("event ") && event.name.contains(".rs:");
    let message = if unnamed && !fields.is_empty() {
        fields.join(" ")
    } else {
        event.name.clone()
    };
    json!({
        "span_id": span,
        "time": micros(event.time_unix_nano),
        "level": level,
        "logger": logger,
        "message": message,
        "exception": null,
        "attrs": out,
    })
}

/// A GraphQL gateway's request names its operation on the span under it, not on its own: Hive Gateway's
/// `graphql.operation`, Hive Router's, Grafbase Gateway's `graphql`. The root takes it from the span right under it
/// (not from a call to a subgraph, which names the subgraph's operation), unless it names one itself.
fn lift_operation(
    root_attrs: &mut Map<String, Value>,
    root_id: u64,
    members: &[u64],
    bucket: &Bucket,
) {
    let keys = ["graphql.operation.type", "graphql.operation.name"];
    if keys.iter().all(|key| text(root_attrs, &[key]).is_some()) {
        return;
    }
    let operation = members.iter().find_map(|id| {
        let span = &bucket.spans[id].span;
        if *id == root_id
            || matches!(span.kind, 3 | 4)
            || id64(&span.parent_span_id) != Some(root_id)
        {
            return None;
        }
        let attrs = attributes(&span.attributes);
        let (Some(kind), Some(name)) = (text(&attrs, &[keys[0]]), text(&attrs, &[keys[1]])) else {
            return None;
        };
        Some((kind.to_owned(), name.to_owned()))
    });
    if let Some((kind, name)) = operation {
        root_attrs.insert(keys[0].into(), Value::from(kind));
        root_attrs.insert(keys[1].into(), Value::from(name));
    }
}

/// One trace: the root as the trace (and as a span too when it is a call out), the rest as its spans.
fn document(trace: u128, root: &Got, root_id: u64, members: &[u64], bucket: &Bucket) -> Value {
    let mut root_attrs = attributes(&root.span.attributes);
    let tower = tower_request(&mut root_attrs);
    lift_operation(&mut root_attrs, root_id, members, bucket);
    // tracing-opentelemetry records a `u16` field as its digits: the status code as a number again.
    for key in ["http.response.status_code", "http.status_code"] {
        if let Some(code) = count(&root_attrs, key) {
            root_attrs.insert(key.into(), Value::from(code));
        }
    }
    let has_status = ["http.response.status_code", "http.status_code"]
        .iter()
        .any(|key| root_attrs.contains_key(*key));
    if !has_status && let Some(status) = tower_status(&root.span) {
        root_attrs.insert("http.response.status_code".into(), Value::from(status));
    }
    // tower-http's request span is a server's, whatever kind it was exported as.
    let span_kind = if tower { 2 } else { root.span.kind };
    let (kind, role) = kind_of(span_kind, &root_attrs);
    let mut attrs = trace_attrs(root, &root_attrs, kind, role);
    // The framework, as the SDKs name it: from the instrumentation that recorded the trace's spans (OpenTelemetry's
    // Java agent records a Spring request from Tomcat, its controller from spring-webmvc).
    if let Some(framework) = members
        .iter()
        .find_map(|id| framework(&bucket.spans[id].scope))
    {
        attrs.insert("tracepanel.framework".into(), Value::from(framework));
    }
    let status_code = attrs
        .get("http.status_code")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let failed = root
        .span
        .status
        .as_ref()
        .is_some_and(|status| status.code == STATUS_ERROR)
        || status_code >= 500;
    let name = trace_name(&root.span, &root_attrs, kind);
    // The trace's own span, as the SDKs send it: the request (or the task, the command) its spans hang under, the
    // one span without a parent. A command that only called out (a script's request) keeps its call as that span:
    // the call is its work.
    let root_is_call = matches!(root.span.kind, 3 | 4);
    let mut spans: Vec<Value> = members
        .iter()
        .map(|id| {
            let got = &bucket.spans[id];
            if *id != root_id {
                let parent = id64(&got.span.parent_span_id).map(|parent| span_id(trace, parent));
                return span_doc(trace, got, parent, bucket);
            }
            if root_is_call {
                return span_doc(trace, got, None, bucket);
            }
            // Its attributes are the trace's, as an SDK's request span has none of its own.
            json!({
                "id": span_id(trace, root_id),
                "parent_id": null,
                "kind": kind,
                "name": name,
                "start": micros(got.span.start_time_unix_nano),
                "duration": micros(got.span.end_time_unix_nano.saturating_sub(got.span.start_time_unix_nano)),
                "status": if failed { "error" } else { "ok" },
                "attrs": {},
            })
        })
        .collect();
    let mut logs = Vec::new();
    for id in members {
        events(trace, *id, root_id, bucket, &mut spans, &mut logs);
    }
    spans.sort_by_key(|span| span["start"].as_i64());
    logs.sort_by_key(|log| log["time"].as_i64());
    let errors: Vec<Value> = members
        .iter()
        .flat_map(|id| errors(trace, &bucket.spans[id], *id == root_id))
        .collect();
    json!({
        "id": trace_id(trace, root_id),
        "kind": kind,
        "name": name,
        "start": micros(root.span.start_time_unix_nano),
        "duration": micros(root.span.end_time_unix_nano.saturating_sub(root.span.start_time_unix_nano)),
        "status": if failed { "error" } else { "ok" },
        "attrs": attrs,
        "spans": spans,
        "logs": logs,
        "errors": errors,
        "links": [],
        "issues": [],
    })
}

#[cfg(test)]
mod tests {
    use super::framework;

    #[test]
    fn a_scope_names_its_framework() {
        assert_eq!(
            [
                "io.opentelemetry.spring-webmvc-6.0",
                "OpenTelemetry.Instrumentation.AspNetCore",
                "OpenTelemetry::Instrumentation::Rails",
                "io.opentelemetry.contrib.php.laravel",
                "go.opentelemetry.io/contrib/instrumentation/github.com/gin-gonic/gin/otelgin",
                "opentelemetry_phoenix",
                "@opentelemetry/instrumentation-fastify",
                "io.opentelemetry.tomcat-10.0",
                "opentelemetry.instrumentation.sqlalchemy",
            ]
            .map(framework),
            [
                Some("Spring"),
                Some("ASP.NET Core"),
                Some("Rails"),
                Some("Laravel"),
                Some("Gin"),
                Some("Phoenix"),
                Some("Fastify"),
                None,
                None,
            ]
        );
    }
}
