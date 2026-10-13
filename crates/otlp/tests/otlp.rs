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
        shop.trace.spans[0].attrs["code.origin"],
        "shop/views.py:31 in order"
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
    assert_eq!(docs[0]["spans"][0]["attrs"].get("w3c.span_id"), None);
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
        (5, 6)
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
    assert_eq!(
        (
            &docs[0]["spans"][0]["status"],
            &docs[0]["spans"][0]["start"],
            &docs[0]["spans"][0]["attrs"]["otel.span_kind"]
        ),
        (
            &json!("error"),
            &json!(1_544_712_660_100_000_i64),
            &json!("client")
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
    let router = tracepanel_otlp::router(sink, Activity::default());
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
        .oneshot(post(b"{".to_vec(), "application/json"))
        .await
        .unwrap();
    assert_eq!(refused.status(), StatusCode::BAD_REQUEST);

    tokio::time::sleep(QUIET + Duration::from_secs(1)).await;
    let batches = batches.lock().unwrap();
    let docs: Vec<Value> = serde_json::from_slice(&batches[0].frame).unwrap();
    assert_eq!(
        (batches.len(), docs.len(), &docs[0]["name"]),
        (1, 1, &json!("GET /orders/{id}"))
    );
}
