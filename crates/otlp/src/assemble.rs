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

use crate::proto::{
    AnyValue, ExportTraceServiceRequest, FLAG_HAS_IS_REMOTE, FLAG_IS_REMOTE, KeyValue,
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
        .map(|(root, members)| document(trace, &bucket.spans[&root], root, &members, bucket))
        .collect()
}

fn micros(nanos: u64) -> i64 {
    i64::try_from(nanos / 1000).unwrap_or(i64::MAX)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// What came in, from the root's kind and attributes: a request served (HTTP, or an RPC call such as gRPC), a task
/// taken, or a command run.
fn kind_of(root: &Span, attrs: &Map<String, Value>) -> (&'static str, &'static str) {
    let http = text(attrs, &["http.request.method", "http.method"]).is_some();
    if root.kind == 2 && http {
        return ("http", "web");
    }
    if root.kind == 2 && text(attrs, &["rpc.system"]).is_some() {
        return ("rpc", "web");
    }
    let processing = matches!(
        text(attrs, &["messaging.operation.type", "messaging.operation"]),
        Some("process" | "receive")
    );
    if root.kind == 5 || processing {
        return ("task", "worker");
    }
    if root.kind == 2 {
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

/// A GraphQL server's operation, as its type and name: from the conventions' `graphql.operation.*`, or from a span named
/// after it (Apollo Router's `query Books`). The trace is named after it, as the SDKs name theirs.
fn graphql_operation(root: &Span, attrs: &Map<String, Value>) -> Option<(String, String)> {
    if let (Some(operation), Some(name)) = (
        text(attrs, &["graphql.operation.type"]),
        text(attrs, &["graphql.operation.name"]),
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

fn span_doc(trace: u128, got: &Got, parent: Option<String>) -> Value {
    let span = &got.span;
    let mut attrs = attributes(&span.attributes);
    attrs.insert("otel.span_kind".into(), Value::from(span_kind(span.kind)));
    attrs.insert("otel.scope".into(), Value::from(&*got.scope));
    if let Some(origin) = origin(&attrs) {
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
    if matches!(span.kind, 3 | 4) && carries {
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

/// One trace: the root as the trace (and as a span too when it is a call out), the rest as its spans.
fn document(trace: u128, root: &Got, root_id: u64, members: &[u64], bucket: &Bucket) -> Value {
    let root_attrs = attributes(&root.span.attributes);
    let (kind, role) = kind_of(&root.span, &root_attrs);
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
    // A command that only called out (a script's request) keeps its call as a span: the call is its work.
    let root_is_call = matches!(root.span.kind, 3 | 4);
    let parent_of = |got: &Got| {
        let parent = id64(&got.span.parent_span_id)?;
        (parent != root_id || root_is_call).then(|| span_id(trace, parent))
    };
    let mut spans: Vec<Value> = members
        .iter()
        .filter(|id| **id != root_id || root_is_call)
        .map(|id| {
            let got = &bucket.spans[id];
            let parent = if *id == root_id { None } else { parent_of(got) };
            span_doc(trace, got, parent)
        })
        .collect();
    spans.sort_by_key(|span| span["start"].as_i64());
    let errors: Vec<Value> = members
        .iter()
        .flat_map(|id| errors(trace, &bucket.spans[id], *id == root_id))
        .collect();
    json!({
        "id": trace_id(trace, root_id),
        "kind": kind,
        "name": trace_name(&root.span, &root_attrs, kind),
        "start": micros(root.span.start_time_unix_nano),
        "duration": micros(root.span.end_time_unix_nano.saturating_sub(root.span.start_time_unix_nano)),
        "status": if failed { "error" } else { "ok" },
        "attrs": attrs,
        "spans": spans,
        "logs": [],
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
