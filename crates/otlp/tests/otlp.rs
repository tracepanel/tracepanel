//! OTLP/HTTP as exporters send it: exports captured from OpenTelemetry's Python SDK 1.45.1 (tests/fixtures/capture.py
//! makes them), and OTLP/JSON as the specification writes it.

use axum::body::Body;
use axum::http::{HeaderMap, HeaderValue, Request, StatusCode, header};
use serde_json::{Value, json};
use std::io::Write;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tower::ServiceExt;
use tracepanel_otlp::assemble::{Assembler, LINGER, QUIET, WAIT};
use tracepanel_protocol::{Activity, Batch, Received, Thresholds};

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(name),
    )
    .unwrap()
}

/// The three services' exports: shop serving a request (and calling billing), billing serving that call, a worker.
fn exports() -> Vec<Vec<u8>> {
    ["python-0.pb", "python-1.pb", "python-2.pb"]
        .map(fixture)
        .to_vec()
}

fn assembled(start: Instant) -> Vec<Value> {
    let mut assembler = Assembler::default();
    for export in exports() {
        assembler.add(
            tracepanel_otlp::decode(&HeaderMap::new(), &export).unwrap(),
            start,
        );
    }
    let mut docs = assembler.ready(start + QUIET);
    docs.sort_by_key(|doc| doc["start"].as_i64());
    docs
}

/// A trace as the agent keeps it: its `otel` spans mapped, its issues found.
fn analyzed(doc: &Value) -> Received {
    let mut received = Received {
        trace: serde_json::from_value(doc.clone()).unwrap(),
        doc: doc.to_string(),
    };
    tracepanel_analysis::apply(&mut received, &Thresholds::default());
    received
}

#[test]
fn a_service_a_trace_each_with_what_came_in() {
    let docs = assembled(Instant::now());
    let summary: Vec<_> = docs
        .iter()
        .map(|doc| {
            (
                doc["kind"].clone(),
                doc["name"].clone(),
                doc["status"].clone(),
                doc["attrs"]["service.name"].clone(),
                doc["attrs"]["service.role"].clone(),
            )
        })
        .collect();

    assert_eq!(
        summary,
        [
            (
                json!("http"),
                json!("GET /orders/{id}"),
                json!("ok"),
                json!("shop"),
                json!("web")
            ),
            (
                json!("http"),
                json!("POST /charge"),
                json!("error"),
                json!("billing"),
                json!("web")
            ),
            (
                json!("task"),
                json!("orders process"),
                json!("ok"),
                json!("mailer"),
                json!("worker")
            ),
        ]
    );

    let shop = &docs[0]["attrs"];
    assert_eq!(
        (
            &shop["http.method"],
            &shop["http.path"],
            &shop["http.route"],
            &shop["http.status_code"],
            &shop["user.id"]
        ),
        (
            &json!("GET"),
            &json!("/orders/7"),
            &json!("/orders/{id}"),
            &json!(200),
            &json!("42")
        )
    );
    assert_eq!(docs[2]["attrs"]["task.system"], "rabbitmq");
    // What the services map draws the broker from.
    assert_eq!(docs[2]["attrs"]["messaging.system"], "rabbitmq");
    assert_eq!(docs[2]["attrs"]["task.queue"], "orders");

    // billing's exception, as the trace's error.
    assert_eq!(
        docs[1]["errors"],
        json!([{"span_id": null, "time": docs[1]["errors"][0]["time"], "type": "ValueError",
                "message": "card declined", "handled": false, "frames": [], "chain": []}])
    );
}

#[test]
fn the_agent_maps_the_spans_and_finds_the_issues() {
    let docs = assembled(Instant::now());
    let shop = analyzed(&docs[0]);

    let kinds: Vec<_> = shop
        .trace
        .spans
        .iter()
        .map(|span| (span.kind.as_str(), span.name.as_str()))
        .collect();
    assert_eq!(
        kinds,
        [
            ("http", "GET /orders/{id}"),
            ("sql", "SELECT order_item"),
            ("sql", "SELECT order_item"),
            ("sql", "SELECT order_item"),
            ("sql", "SELECT order_item"),
            ("redis", "GET order:7"),
            ("http.client", "POST billing/charge"),
        ]
    );
    let issues: Vec<_> = shop
        .trace
        .issues
        .iter()
        .map(|issue| issue.kind.as_str())
        .collect();
    assert_eq!(issues, ["n+1"]);
    assert_eq!(
        shop.trace.spans[1].attrs["code.origin"],
        "shop/views.py:31 in order"
    );
    // The call to billing keeps the W3C id billing's trace names as its parent.
    assert_eq!(
        shop.trace.spans[6].attrs["w3c.span_id"],
        docs[1]["attrs"]["w3c.parent_span_id"]
    );
}

#[test]
fn the_w3c_ids_link_a_call_to_the_service_that_served_it() {
    let docs = assembled(Instant::now());
    let call = docs[0]["spans"]
        .as_array()
        .unwrap()
        .iter()
        .find(|span| span["name"] == "POST")
        .unwrap();

    // Only calls that carry the trace on get theirs: not the SQL.
    assert_eq!(docs[0]["spans"][1]["attrs"].get("w3c.span_id"), None);
    assert_eq!(
        docs[1]["attrs"]["w3c.parent_span_id"],
        call["attrs"]["w3c.span_id"]
    );
    assert_eq!(
        docs[1]["attrs"]["w3c.trace_id"],
        docs[0]["attrs"]["w3c.trace_id"]
    );
    assert_eq!(docs[0]["attrs"].get("w3c.parent_span_id"), None);
}

#[test]
fn a_trace_waits_for_its_spans_to_stop_coming() {
    let start = Instant::now();
    let mut assembler = Assembler::default();
    assembler.add(
        tracepanel_otlp::decode(&HeaderMap::new(), &exports()[0]).unwrap(),
        start,
    );

    assert_eq!(
        assembler.ready(start + QUIET - Duration::from_millis(1)),
        Vec::<Value>::new()
    );
    assert_eq!(assembler.ready(start + QUIET).len(), 1);
    // Sent: nothing more until something new comes.
    assert_eq!(assembler.ready(start + QUIET * 2), Vec::<Value>::new());
}

#[test]
fn a_root_late_in_coming_is_waited_for_then_given_up_on() {
    // billing's export without its server span: an INSERT whose parent hasn't come.
    let mut request = tracepanel_otlp::decode(&HeaderMap::new(), &exports()[1]).unwrap();
    request.resource_spans[0]
        .scope_spans
        .retain(|scope| scope.spans.iter().all(|span| span.kind != 2));
    let start = Instant::now();
    let mut assembler = Assembler::default();
    assembler.add(request, start);

    assert_eq!(assembler.ready(start + QUIET), Vec::<Value>::new());
    let docs = assembler.ready(start + WAIT);
    assert_eq!(
        (docs.len(), &docs[0]["kind"], &docs[0]["name"]),
        (1, &json!("command"), &json!("INSERT"))
    );
}

#[test]
fn a_late_span_sends_its_trace_again_under_the_same_id() {
    let start = Instant::now();
    let mut assembler = Assembler::default();
    let request = tracepanel_otlp::decode(&HeaderMap::new(), &exports()[0]).unwrap();
    let mut early = request.clone();
    early.resource_spans[0]
        .scope_spans
        .retain(|scope| scope.spans.iter().all(|span| span.name != "GET"));
    assembler.add(early, start);
    let first = assembler.ready(start + QUIET);

    assembler.add(request, start + QUIET);
    let again = assembler.ready(start + QUIET * 2);

    assert_eq!((first.len(), again.len()), (1, 1));
    assert_eq!(first[0]["id"], again[0]["id"]);
    assert_eq!(
        (
            first[0]["spans"].as_array().unwrap().len(),
            again[0]["spans"].as_array().unwrap().len()
        ),
        (6, 7)
    );
    // Long after, it is forgotten: the same spans again are a new arrival.
    assert_eq!(
        assembler.ready(start + QUIET * 2 + LINGER),
        Vec::<Value>::new()
    );
}

#[test]
fn otlp_json_as_the_specification_writes_it() {
    let export = json!({"resourceSpans": [{
        "resource": {"attributes": [{"key": "service.name", "value": {"stringValue": "api"}}]},
        "scopeSpans": [{"scope": {"name": "manual"}, "spans": [
            {"traceId": "5b8efff798038103d269b633813fc60c", "spanId": "eee19b7ec3c1b174", "name": "GET /books",
             "kind": 2, "startTimeUnixNano": "1544712660000000000", "endTimeUnixNano": "1544712661000000000",
             "attributes": [{"key": "http.request.method", "value": {"stringValue": "GET"}},
                            {"key": "http.response.status_code", "value": {"intValue": "200"}}]},
            {"traceId": "5b8efff798038103d269b633813fc60c", "spanId": "eee19b7ec3c1b175",
             "parentSpanId": "eee19b7ec3c1b174", "name": "SELECT books", "kind": "SPAN_KIND_CLIENT",
             "startTimeUnixNano": 1544712660100000000_u64, "endTimeUnixNano": "1544712660200000000",
             "status": {"code": 2, "message": "timeout"},
             "attributes": [{"key": "db.system.name", "value": {"stringValue": "mysql"}},
                            {"key": "db.query.text", "value": {"stringValue": "SELECT * FROM books"}}]}]}]}]});
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    let mut assembler = Assembler::default();
    let start = Instant::now();
    assembler.add(
        tracepanel_otlp::decode(&headers, export.to_string().as_bytes()).unwrap(),
        start,
    );
    let docs = assembler.ready(start + QUIET);

    assert_eq!(
        (
            &docs[0]["name"],
            &docs[0]["start"],
            &docs[0]["duration"],
            &docs[0]["attrs"]["http.status_code"]
        ),
        (
            &json!("GET /books"),
            &json!(1_544_712_660_000_000_i64),
            &json!(1_000_000),
            &json!(200)
        )
    );
    // The trace's own span first, the request; the query under it.
    assert_eq!(
        (
            &docs[0]["spans"][0]["kind"],
            &docs[0]["spans"][0]["parent_id"]
        ),
        (&json!("http"), &Value::Null)
    );
    assert_eq!(
        (
            &docs[0]["spans"][1]["status"],
            &docs[0]["spans"][1]["start"],
            &docs[0]["spans"][1]["attrs"]["otel.span_kind"]
        ),
        (
            &json!("error"),
            &json!(1_544_712_660_100_000_i64),
            &json!("client")
        )
    );
}

#[test]
fn a_spring_app_under_the_java_agent_is_labelled_java_and_spring() {
    // As OpenTelemetry's Java agent sends a Spring MVC request: Tomcat records it, spring-webmvc its controller.
    let export = json!({"resourceSpans": [{
        "resource": {"attributes": [
            {"key": "service.name", "value": {"stringValue": "petclinic"}},
            {"key": "telemetry.sdk.language", "value": {"stringValue": "java"}},
            {"key": "process.runtime.version", "value": {"stringValue": "21.0.9+10-LTS"}}]},
        "scopeSpans": [
            {"scope": {"name": "io.opentelemetry.tomcat-10.0"}, "spans": [
                {"traceId": "5b8efff798038103d269b633813fc60d", "spanId": "eee19b7ec3c1b176", "name": "GET /owners/{id}",
                 "kind": 2, "startTimeUnixNano": "1544712660000000000", "endTimeUnixNano": "1544712661000000000",
                 "attributes": [{"key": "http.request.method", "value": {"stringValue": "GET"}},
                                {"key": "http.route", "value": {"stringValue": "/owners/{id}"}}]}]},
            {"scope": {"name": "io.opentelemetry.spring-webmvc-6.0"}, "spans": [
                {"traceId": "5b8efff798038103d269b633813fc60d", "spanId": "eee19b7ec3c1b177",
                 "parentSpanId": "eee19b7ec3c1b176", "name": "OwnerController.show", "kind": 1,
                 "startTimeUnixNano": "1544712660100000000", "endTimeUnixNano": "1544712660900000000"}]}]}]});
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    let mut assembler = Assembler::default();
    let start = Instant::now();
    assembler.add(
        tracepanel_otlp::decode(&headers, export.to_string().as_bytes()).unwrap(),
        start,
    );
    let docs = assembler.ready(start + QUIET);

    assert_eq!(
        (
            &docs[0]["attrs"]["telemetry.sdk.language"],
            &docs[0]["attrs"]["tracepanel.framework"]
        ),
        (&json!("java"), &json!("Spring"))
    );
}

#[test]
fn a_grpc_call_served_is_an_rpc_trace() {
    let export = json!({"resourceSpans": [{
        "resource": {"attributes": [{"key": "service.name", "value": {"stringValue": "greeter"}}]},
        "scopeSpans": [{"scope": {"name": "grpc"}, "spans": [
            {"traceId": "5b8efff798038103d269b633813fc60c", "spanId": "eee19b7ec3c1b174",
             "name": "helloworld.Greeter/SayHello", "kind": 2,
             "startTimeUnixNano": "1544712660000000000", "endTimeUnixNano": "1544712660020000000",
             "attributes": [{"key": "rpc.system", "value": {"stringValue": "grpc"}},
                            {"key": "rpc.service", "value": {"stringValue": "helloworld.Greeter"}},
                            {"key": "rpc.method", "value": {"stringValue": "SayHello"}},
                            {"key": "rpc.grpc.status_code", "value": {"intValue": "0"}}]}]}]}]});
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    let mut assembler = Assembler::default();
    let start = Instant::now();
    assembler.add(
        tracepanel_otlp::decode(&headers, export.to_string().as_bytes()).unwrap(),
        start,
    );
    let docs = assembler.ready(start + QUIET);

    assert_eq!(
        (
            &docs[0]["kind"],
            &docs[0]["name"],
            &docs[0]["attrs"]["service.role"]
        ),
        (
            &json!("rpc"),
            &json!("helloworld.Greeter/SayHello"),
            &json!("web")
        )
    );
    assert_eq!(
        (
            &docs[0]["attrs"]["rpc.system"],
            &docs[0]["attrs"]["rpc.service"],
            &docs[0]["attrs"]["rpc.method"],
            &docs[0]["attrs"]["rpc.grpc.status_code"],
            docs[0]["attrs"].get("http.method")
        ),
        (
            &json!("grpc"),
            &json!("helloworld.Greeter"),
            &json!("SayHello"),
            &json!(0),
            None
        )
    );
}

#[test]
fn gzipped_exports_are_read() {
    let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    gzip.write_all(&exports()[0]).unwrap();
    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_ENCODING, HeaderValue::from_static("gzip"));

    let request = tracepanel_otlp::decode(&headers, &gzip.finish().unwrap()).unwrap();
    assert_eq!(
        request,
        tracepanel_otlp::decode(&HeaderMap::new(), &exports()[0]).unwrap()
    );
}

#[tokio::test(start_paused = true)]
async fn the_endpoint_takes_an_export_and_sends_its_traces_on() {
    let batches: Arc<Mutex<Vec<Batch>>> = Arc::default();
    let sink = {
        let batches = batches.clone();
        Arc::new(move |batch: Batch| batches.lock().unwrap().push(batch))
    };
    let router = tracepanel_otlp::router(sink, Activity::default(), "shop".into());
    let post = |body: Vec<u8>, content_type: &'static str| {
        Request::post("/v1/traces")
            .header(header::CONTENT_TYPE, content_type)
            .body(Body::from(body))
            .unwrap()
    };

    let response = router
        .clone()
        .oneshot(post(exports()[0].clone(), "application/x-protobuf"))
        .await
        .unwrap();
    assert_eq!(
        (
            response.status(),
            response.headers()[header::CONTENT_TYPE].to_str().unwrap()
        ),
        (StatusCode::OK, "application/x-protobuf")
    );
    let refused = router
        .clone()
        .oneshot(post(b"{".to_vec(), "application/json"))
        .await
        .unwrap();
    assert_eq!(refused.status(), StatusCode::BAD_REQUEST);

    // Whose agent it is, for another project's agent that wants the same port.
    let identity = router
        .oneshot(Request::get("/tracepanel").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(identity.status(), StatusCode::OK);
    let body = axum::body::to_bytes(identity.into_body(), 1 << 10)
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap(),
        json!({"tracepanel": env!("CARGO_PKG_VERSION"), "project": "shop"})
    );

    tokio::time::sleep(QUIET + Duration::from_secs(1)).await;
    let batches = batches.lock().unwrap();
    let docs: Vec<Value> = serde_json::from_slice(&batches[0].frame).unwrap();
    assert_eq!(
        (batches.len(), docs.len(), &docs[0]["name"]),
        (1, 1, &json!("GET /orders/{id}"))
    );
}

/// Apollo Router 2.18's trace of one query through it to a subgraph (tests/fixtures/apollo-router-*.json, one per
/// `spans.mode`), as the agent keeps it.
fn router(mode: &str) -> Received {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    let start = Instant::now();
    let mut assembler = Assembler::default();
    assembler.add(
        tracepanel_otlp::decode(&headers, &fixture(&format!("apollo-router-{mode}.json"))).unwrap(),
        start,
    );
    let docs = assembler.ready(start + QUIET);
    assert_eq!(docs.len(), 1);
    analyzed(&docs[0])
}

#[test]
fn apollo_router_s_request_to_its_subgraph_is_a_call_that_links_its_trace() {
    for (mode, subgraph_parent) in [
        ("spec-compliant", "04e918f5f648dcf5"),
        ("deprecated", "9ff0673cffc76eca"),
    ] {
        let received = router(mode);
        let doc: Value = serde_json::from_str(&received.doc).unwrap();
        let tree: Vec<(&str, &str, Option<&str>)> = doc["spans"]
            .as_array()
            .unwrap()
            .iter()
            .map(|span| {
                let parent = span["parent_id"].as_str().map(|id| {
                    doc["spans"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|each| each["id"] == id)
                        .unwrap()["name"]
                        .as_str()
                        .unwrap()
                });
                (
                    span["kind"].as_str().unwrap(),
                    span["name"].as_str().unwrap(),
                    parent,
                )
            })
            .collect();
        let call = doc["spans"]
            .as_array()
            .unwrap()
            .iter()
            .find(|span| span["kind"] == "http.client")
            .unwrap();

        // The Router's stages are left out, their calls under the request: one call to the subgraph, the span whose
        // id the subgraph got, so the subgraph's trace links to it.
        assert_eq!(doc["name"], "GraphQL query Books", "{mode}");
        assert_eq!(
            (
                &doc["attrs"]["graphql.operation.type"],
                &doc["attrs"]["graphql.operation.name"]
            ),
            (&json!("query"), &json!("Books"))
        );
        assert_eq!(
            tree.iter()
                .filter(|(kind, ..)| *kind == "http.client")
                .count(),
            1,
            "{mode}: {tree:?}"
        );
        assert!(
            tree.iter().all(|(kind, ..)| *kind != "function"),
            "{mode}: {tree:?}"
        );
        assert_eq!(call["name"], "POST host.docker.internal/", "{mode}");
        // Under the request, the trace's own span, as an SDK's: what the console opens under the call that reached it.
        assert_eq!(tree[0], ("http", "GraphQL query Books", None), "{mode}");
        assert!(
            tree[1..]
                .iter()
                .all(|(.., parent)| *parent == Some("GraphQL query Books")),
            "{mode}: {tree:?}"
        );
        // What came over OTLP stays with it: the Router's span, named only by its URL, and why it is a call.
        let mut came = call["received"].clone();
        let attrs = came.as_object_mut().unwrap().remove("attrs").unwrap();
        assert_eq!(
            came,
            json!({
                "name": "http_request", "span_kind": "client", "scope": "apollo-router",
                "mapped_as": "Apollo Router's call to a subgraph: a POST to http.url. It carries the trace on: \
                              links the trace of the service it called",
                "same": {
                    "code.origin": "code.origin", "http.response.status_code": "http.response.status_code",
                    "http.url": "url.full", "net.peer.name": "server.address", "w3c.span_id": "w3c.span_id",
                },
            }),
            "{mode}"
        );
        assert_eq!(
            attrs.as_object().unwrap().keys().collect::<Vec<_>>(),
            [
                "busy_ns",
                "code.filepath",
                "code.lineno",
                "code.namespace",
                "http.route",
                "idle_ns",
                "net.peer.port",
                "net.transport",
                "thread.id",
                "thread.name"
            ],
            "{mode}"
        );
        assert_eq!(call["attrs"]["w3c.span_id"], subgraph_parent, "{mode}");
        assert_eq!(
            received.trace.spans.len(),
            doc["spans"].as_array().unwrap().len()
        );
    }
}

#[test]
fn a_cors_preflight_and_apollo_router_s_own_start_are_nobody_s_traces() {
    let span = |trace: &str, id: &str, name: &str, kind: i32, scope: &str, method: Option<&str>| {
        let attributes: Vec<Value> = method
            .map(|method| json!({"key": "http.request.method", "value": {"stringValue": method}}))
            .into_iter()
            .collect();
        json!({"scope": {"name": scope}, "spans": [
            {"traceId": trace, "spanId": id, "name": name, "kind": kind, "startTimeUnixNano": "1544712660000000000",
             "endTimeUnixNano": "1544712660100000000", "attributes": attributes}]})
    };
    let export = json!({"resourceSpans": [{
    "resource": {"attributes": [{"key": "service.name", "value": {"stringValue": "library-router"}}]},
    "scopeSpans": [
        span("5b8efff798038103d269b633813fc601", "eee19b7ec3c1b171", "starting", 1, "apollo-router", None),
        span("5b8efff798038103d269b633813fc602", "eee19b7ec3c1b172", "request", 2, "apollo-router", Some("OPTIONS")),
        span("5b8efff798038103d269b633813fc603", "eee19b7ec3c1b173", "query Books", 2, "apollo-router", Some("POST")),
        span("5b8efff798038103d269b633813fc604", "eee19b7ec3c1b174", "nightly-report", 1, "manual", None),
    ]}]});
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    let start = Instant::now();
    let mut assembler = Assembler::default();
    assembler.add(
        tracepanel_otlp::decode(&headers, export.to_string().as_bytes()).unwrap(),
        start,
    );

    let mut names: Vec<Value> = assembler
        .ready(start + QUIET)
        .into_iter()
        .map(|doc| doc["name"].clone())
        .collect();
    names.sort_by_key(ToString::to_string);

    // Another program's internal root (a script's run) is still a command.
    assert_eq!(
        names,
        [json!("GraphQL query Books"), json!("nightly-report")]
    );
}

/// An axum app's export through tracing-opentelemetry 0.34 (tests/fixtures/rust-tracing.json, made by hand in its
/// shape): tower-http's `TraceLayer` request span, a handler under `#[tracing::instrument]` with the queries sqlx
/// logged as its events, a reqwest-tracing call, two log lines, and a browser's CORS preflight. The export as it
/// is, or changed by `change`, assembled.
fn rust_app(change: impl FnOnce(&mut Value)) -> Vec<Value> {
    let mut export: Value = serde_json::from_slice(&fixture("rust-tracing.json")).unwrap();
    change(&mut export);
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    let start = Instant::now();
    let mut assembler = Assembler::default();
    assembler.add(
        tracepanel_otlp::decode(&headers, export.to_string().as_bytes()).unwrap(),
        start,
    );
    assembler.ready(start + QUIET)
}

/// The spans sqlx's events became: parent, start, duration and attributes.
fn queries(doc: &Value) -> Vec<Value> {
    doc["spans"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|span| span["attrs"]["otel.scope"] == "sqlx")
        .map(|span| {
            json!([
                span["parent_id"],
                span["start"],
                span["duration"],
                span["name"],
                span["attrs"]
            ])
        })
        .collect()
}

#[test]
fn tower_http_s_request_span_is_a_request_named_by_its_method_and_path() {
    let docs = rust_app(|_| {});

    // The preflight is nobody's trace.
    assert_eq!(docs.len(), 1);

    assert_eq!(
        (
            &docs[0]["kind"],
            &docs[0]["name"],
            &docs[0]["status"],
            &docs[0]["attrs"]
        ),
        (
            &json!("http"),
            &json!("GET /books"),
            &json!("ok"),
            &json!({
                "http.method": "GET",
                "http.path": "/books",
                // From TraceLayer's `finished processing request` event.
                "http.status_code": 200,
                "service.name": "shop",
                "service.role": "web",
                "telemetry.sdk.language": "rust",
                "w3c.trace_id": "e502e43e6d7f60c9c10bfadbb38c62f6",
            })
        )
    );
    assert_eq!(
        docs[0]["spans"][0],
        json!({"id": docs[0]["spans"][0]["id"], "parent_id": null, "kind": "http", "name": "GET /books",
               "start": 1_793_439_824_000_000_i64, "duration": 1320, "status": "ok", "attrs": {}})
    );
}

#[test]
fn sqlx_s_queries_are_sql_spans_of_the_span_they_ran_in() {
    let docs = rust_app(|_| {});
    let handler = &docs[0]["spans"][1];
    let base = 1_793_439_824_000_000_i64;
    let attrs = |sql: &str, rows: i64| {
        json!({
            "code.origin": "src/main.rs:35 in books",
            "db.query.text": sql,
            "db.response.affected_rows": 0,
            "db.response.returned_rows": rows,
            "db.system.name": "other_sql",
            "otel.scope": "sqlx",
            "otel.span_kind": "client",
        })
    };
    let by_id = "SELECT title FROM books WHERE id = ?";

    assert_eq!(handler["name"], "books");

    // Each ends when sqlx logged it and took its `elapsed_secs`. Its statement is `db.statement`, or the summary when
    // that is empty (four words or fewer). Its call site is the handler's, not sqlx's logger.
    assert_eq!(
        queries(&docs[0]),
        [
            json!([
                handler["id"],
                base + 30,
                90,
                "SELECT id FROM books …",
                attrs("SELECT id FROM books ORDER BY id", 4)
            ]),
            json!([
                handler["id"],
                base + 180,
                40,
                "SELECT title FROM books …",
                attrs(by_id, 1)
            ]),
            json!([
                handler["id"],
                base + 290,
                30,
                "SELECT title FROM books …",
                attrs(by_id, 1)
            ]),
            json!([
                handler["id"],
                base + 390,
                30,
                "SELECT title FROM books …",
                attrs(by_id, 1)
            ]),
            json!([
                handler["id"],
                base + 490,
                30,
                "SELECT title FROM books …",
                attrs(by_id, 1)
            ]),
            json!([
                handler["id"],
                base + 590,
                10,
                "SELECT 1",
                attrs("SELECT 1", 1)
            ]),
        ]
    );

    let received = analyzed(&docs[0]);
    let first = received
        .trace
        .spans
        .iter()
        .find(|span| span.kind == "sql")
        .unwrap();

    assert_eq!(
        (
            first.name.as_str(),
            serde_json::to_value(&first.attrs).unwrap()
        ),
        (
            "SELECT books",
            json!({
                "code.origin": "src/main.rs:35 in books",
                "db.alias": "sql",
                "db.client": "sqlx",
                "db.fingerprint": "SELECT id FROM books ORDER BY id",
                "db.response.returned_rows": 4,
                "db.statement": "SELECT id FROM books ORDER BY id",
                "db.system": "other_sql",
                "db.vendor": "other_sql",
                "otel.scope": "sqlx",
            })
        )
    );

    let issues: Vec<_> = received
        .trace
        .issues
        .iter()
        .map(|issue| {
            (
                issue.kind.as_str(),
                issue.title.as_str(),
                issue.culprit.as_deref(),
                issue.count,
            )
        })
        .collect();
    assert_eq!(
        issues,
        [(
            "n+1",
            "N+1: 4 similar queries · SELECT books",
            Some("src/main.rs:35 in books"),
            4
        )]
    );
}

#[test]
fn a_query_s_database_is_the_one_the_app_names() {
    let docs = rust_app(|export| {
        export["resourceSpans"][0]["resource"]["attributes"]
            .as_array_mut()
            .unwrap()
            .push(json!({"key": "db.system.name", "value": {"stringValue": "postgresql"}}));
    });

    let received = analyzed(&docs[0]);
    let systems: Vec<_> = received
        .trace
        .spans
        .iter()
        .filter(|span| span.kind == "sql")
        .map(|span| {
            (
                span.attrs["db.system"].clone(),
                span.attrs["db.alias"].clone(),
            )
        })
        .collect();
    assert_eq!(systems, vec![(json!("postgresql"), json!("postgresql")); 6]);
}

#[test]
fn other_events_are_the_trace_s_log_records() {
    let docs = rust_app(|_| {});
    let handler = &docs[0]["spans"][1]["id"];

    // TraceLayer's own `started processing request`, `finished processing request` and `end of stream` aren't.
    assert_eq!(
        docs[0]["logs"],
        json!([
            {"span_id": handler, "time": 1_793_439_824_001_100_i64, "level": "info", "logger": "shop",
             "message": "listed books", "exception": null,
             "attrs": {"code.origin": "src/main.rs:50", "extra.count": "4"}},
            // `tracing::warn!(id, status)`, with no message, reads as its fields.
            {"span_id": handler, "time": 1_793_439_824_001_200_i64, "level": "warning", "logger": "shop",
             "message": "id=2 status=200", "exception": null,
             "attrs": {"code.origin": "src/main.rs:58", "extra.id": 2, "extra.status": "200"}},
        ])
    );
}

#[test]
fn a_dependency_s_span_is_where_the_app_called_it_from() {
    let docs = rust_app(|_| {});
    let received = analyzed(&docs[0]);
    let call = received
        .trace
        .spans
        .iter()
        .find(|span| span.kind == "http.client")
        .unwrap();

    // reqwest-tracing's span says it was made in reqwest-tracing, under the cargo registry.
    assert_eq!(
        (
            call.name.as_str(),
            &call.attrs["code.origin"],
            &call.attrs["http.response.status_code"]
        ),
        (
            "GET stock.internal/stock",
            &json!("src/main.rs:35 in books"),
            &json!(200)
        )
    );
}

#[test]
fn an_event_of_another_sdk_is_a_log_record_of_its_scope() {
    let export = json!({"resourceSpans": [{
        "resource": {"attributes": [{"key": "service.name", "value": {"stringValue": "billing"}}]},
        "scopeSpans": [{"scope": {"name": "billing.jobs"}, "spans": [{
            "traceId": "5b8efff798038103d269b633813fc6aa", "spanId": "eee19b7ec3c1b1aa", "name": "nightly-report",
            "kind": 1, "startTimeUnixNano": "1544712660000000000", "endTimeUnixNano": "1544712660100000000",
            "events": [{"timeUnixNano": "1544712660050000000", "name": "cache miss",
                        "attributes": [{"key": "key", "value": {"stringValue": "report:7"}}]}]}]}]}]});
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    let start = Instant::now();
    let mut assembler = Assembler::default();
    assembler.add(
        tracepanel_otlp::decode(&headers, export.to_string().as_bytes()).unwrap(),
        start,
    );

    let docs = assembler.ready(start + QUIET);

    assert_eq!(
        docs[0]["logs"],
        json!([{"span_id": null, "time": 1_544_712_660_050_000_i64, "level": "info", "logger": "billing.jobs",
                "message": "cache miss", "exception": null, "attrs": {"extra.key": "report:7"}}])
    );
}
