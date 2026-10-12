//! The agent keeps its side of the contract on its own: traces as the SDKs really send them (`schema/examples`,
//! recorded with `--record` from the Python SDK under Django, FastAPI and Flask, and from the Go SDK) match
//! `schema/trace.schema.json`, decode, get the issues `expected.json` names, and come back from the console's API
//! with them, still matching the schema.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use tower::ServiceExt;
use tracepanel_protocol::{Activity, Batch, Thresholds};
use tracepanel_store_local::{Reader, Store};

fn schema_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../schema")
}

fn examples() -> Vec<(String, Value, Vec<String>)> {
    let dir = schema_dir().join("examples");
    let expected: BTreeMap<String, Vec<String>> =
        serde_json::from_str(&std::fs::read_to_string(dir.join("expected.json")).unwrap()).unwrap();
    let mut on_disk: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .filter(|name| name.ends_with(".json") && name != "expected.json")
        .collect();
    on_disk.sort();
    // Every example says what it should find, and every expectation has its example.
    assert_eq!(on_disk, expected.keys().cloned().collect::<Vec<_>>());
    expected
        .into_iter()
        .map(|(name, kinds)| {
            let doc =
                serde_json::from_str(&std::fs::read_to_string(dir.join(&name)).unwrap()).unwrap();
            (name, doc, kinds)
        })
        .collect()
}

fn validator() -> jsonschema::Validator {
    let schema: Value = serde_json::from_str(
        &std::fs::read_to_string(schema_dir().join("trace.schema.json")).unwrap(),
    )
    .unwrap();
    jsonschema::validator_for(&schema).unwrap()
}

fn kinds(issues: &Value) -> Vec<String> {
    let mut kinds: Vec<String> = issues
        .as_array()
        .unwrap()
        .iter()
        .map(|issue| issue["kind"].as_str().unwrap().to_owned())
        .collect();
    kinds.sort();
    kinds.dedup();
    kinds
}

#[test]
fn every_example_matches_the_schema_as_the_sdk_sent_it() {
    let validator = validator();
    for (name, doc, _) in examples() {
        let errors: Vec<String> = validator
            .iter_errors(&doc)
            .map(|error| error.to_string())
            .collect();
        assert!(errors.is_empty(), "{name}: {errors:?}");
        // The SDKs send no issues: finding them is the agent's.
        assert_eq!(doc["issues"], Value::Array(vec![]), "{name}");
    }
}

#[tokio::test]
async fn the_agent_finds_the_issues_and_the_api_returns_them() {
    let validator = validator();
    let dir =
        std::env::temp_dir().join(format!("tracepanel-schema-examples-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path = tracepanel_store_local::path_in(&dir);
    let mut store = Store::open(&path).unwrap();
    let router = tracepanel_server::router(Reader::new(&path), Activity::default());

    for (name, doc, expected) in examples() {
        // As the agent receives it: a frame, decoded, analyzed with the default limits, written.
        let batch = Batch {
            frame: serde_json::to_vec(&vec![&doc]).unwrap(),
            max_traces: Some(1000),
            thresholds: Thresholds::default(),
        };
        let mut received = batch
            .decode()
            .unwrap_or_else(|error| panic!("{name}: {error}"));
        for trace in &mut received {
            tracepanel_analysis::apply(trace, &batch.thresholds);
        }
        store.write(&received).unwrap();

        let id = doc["id"].as_str().unwrap();
        let request = Request::get(format!("/api/traces/{id}"))
            .body(Body::empty())
            .unwrap();
        let response = router.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK, "{name}");
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let answer: Value = serde_json::from_slice(&body).unwrap();

        let errors: Vec<String> = validator
            .iter_errors(&answer)
            .map(|error| error.to_string())
            .collect();
        assert!(errors.is_empty(), "{name}: {errors:?}");
        assert_eq!(kinds(&answer["issues"]), expected, "{name}");
    }

    // Several apps in one store: with service=, the menus and an endpoint's page are that app's alone.
    let (status, values) = get(&router, "/api/values?service=api").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        values["route"],
        serde_json::json!(["/books", "/books/fixed", "/boom", "/reports/slow"])
    );

    let (status, every) = get(&router, "/api/values").await;
    assert_eq!(status, StatusCode::OK, "{every}");
    assert!(
        every["route"]
            .as_array()
            .unwrap()
            .contains(&Value::from("/api/report"))
    );

    let (status, detail) = get(
        &router,
        "/api/endpoints/detail?method=GET&route=/books&service=api",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(detail["summary"]["calls"], 1);

    let (status, _) = get(
        &router,
        "/api/endpoints/detail?method=GET&route=/books&service=blog",
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Outgoing HTTP calls per endpoint, heaviest first: an id makes the endpoint's traces a search.
    let (status, calls) = get(&router, "/api/calls?system=http&q=host:127.0.0.1").await;
    assert_eq!(status, StatusCode::OK, "{calls}");
    let rows = calls["calls"].as_array().unwrap();
    let endpoints: Vec<(&str, &str, i64, i64)> = rows
        .iter()
        .map(|row| {
            (
                row["op"].as_str().unwrap(),
                row["template"].as_str().unwrap(),
                row["calls"].as_i64().unwrap(),
                row["most_per_trace"].as_i64().unwrap(),
            )
        })
        .collect();
    assert!(
        endpoints.contains(&("GET", "/users/{id}", 4, 4)),
        "{endpoints:?}"
    );
    assert!(
        endpoints.contains(&("GET", "/rates", 2, 2)),
        "{endpoints:?}"
    );
    let users = rows
        .iter()
        .find(|row| row["template"] == "/users/{id}")
        .unwrap();
    assert_eq!(users["key"].as_str().unwrap().len(), 16);
    assert_eq!(users["errors"], 0);
    assert_eq!(users["traces"], 1);
    assert_eq!(users["sample_trace"], "01M4R1ER9RWER0QHV07BJDSZ7B");

    let (status, found) = get(
        &router,
        &format!("/api/traces?q=call:{}", users["key"].as_str().unwrap()),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{found}");
    let ids: Vec<&str> = found["traces"]
        .as_array()
        .unwrap()
        .iter()
        .map(|trace| trace["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["01M4R1ER9RWER0QHV07BJDSZ7B"]);

    let (_, none) = get(&router, "/api/calls?system=http&q=host:elsewhere.example").await;
    assert_eq!(none["calls"], serde_json::json!([]));

    // The same filters on every list of calls: the target (host:, db:), op:, failed:.
    let (status, posts) = get(&router, "/api/calls?system=http&q=op:get%20failed:false").await;
    assert_eq!(status, StatusCode::OK, "{posts}");
    assert_eq!(posts["calls"].as_array().unwrap().len(), rows.len());
    let (_, failed) = get(&router, "/api/calls?q=failed:true").await;
    assert_eq!(failed["calls"], serde_json::json!([]));
    let (_, writes) = get(&router, "/api/calls?system=sql&q=op:insert").await;
    assert!(
        writes["calls"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["statement"].as_str().unwrap().starts_with("INSERT")),
        "{writes}"
    );

    // Redis used directly: its commands per key pattern, with why they ran.
    let (status, redis) = get(
        &router,
        "/api/calls?system=redis&q=db:redis%20op:get%20via:direct",
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{redis}");
    let commands: Vec<(&str, &str, &str, i64, i64)> = redis["calls"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| {
            (
                row["op"].as_str().unwrap(),
                row["template"].as_str().unwrap(),
                row["via"].as_str().unwrap(),
                row["calls"].as_i64().unwrap(),
                row["most_per_trace"].as_i64().unwrap(),
            )
        })
        .collect();
    assert_eq!(commands, [("GET", "likes:{id}", "direct", 4, 4)]);
    let (_, through_cache) = get(&router, "/api/calls?system=redis&q=via:cache").await;
    assert_eq!(through_cache["calls"], serde_json::json!([]));
    let (status, cache) = get(&router, "/api/calls?system=cache").await;
    assert_eq!(status, StatusCode::OK, "{cache}");

    // The tiles above a system's page: over every call, with the page's filters.
    let (status, summary) = get(&router, "/api/calls/summary?system=redis&q=via:direct").await;
    assert_eq!(status, StatusCode::OK, "{summary}");
    assert_eq!(summary["calls"], redis["calls"][0]["calls"]);
    let (status, _) = get(&router, "/api/calls/summary?q=colour:red").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (status, found) = get(
        &router,
        &format!(
            "/api/traces?q=call:{}",
            redis["calls"][0]["key"].as_str().unwrap()
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{found}");
    assert_eq!(found["traces"][0]["id"], "01M4R1ER9RWER0QHV07BJDSZ7B");

    // What the filter menus offer.
    let (_, values) = get(&router, "/api/values").await;
    assert_eq!(values["targets"]["http"], serde_json::json!(["127.0.0.1"]));
    assert_eq!(values["targets"]["redis"], serde_json::json!(["redis"]));

    let (status, counts) = get(&router, "/api/counts").await;
    assert_eq!(status, StatusCode::OK);
    let systems = |counts: &Value| {
        counts["sections"]["systems"]
            .as_array()
            .unwrap()
            .iter()
            .map(|system| system["system"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>()
    };
    assert_eq!(systems(&counts), ["sql", "redis", "http"]);
    let (_, other) = get(&router, "/api/counts?service=api").await;
    assert_eq!(systems(&other), ["sql"]);
    let _ = std::fs::remove_dir_all(&dir);
}

/// A trace with spans an OpenTelemetry instrumentation recorded, sent as they are (`otel`): the agent maps them, finds
/// their issues like its SDKs' own, and stores and serves them as ordinary kinds.
#[tokio::test]
async fn otel_spans_are_mapped_before_they_are_stored() {
    let dir = std::env::temp_dir().join(format!("tracepanel-otel-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path = tracepanel_store_local::path_in(&dir);
    let mut store = Store::open(&path).unwrap();
    let router = tracepanel_server::router(Reader::new(&path), Activity::default());

    // pg through @opentelemetry/instrumentation-pg: three lookups by key, from one line of a Node app.
    let lookup = |n: i64| {
        serde_json::json!({
            "id": format!("01M4PGSPAN{n:016}"), "parent_id": "01M4PGR00T0000000000000000", "kind": "otel",
            "name": "pg.query:SELECT shop", "start": 1_791_000_000_000_100_i64 + n * 10, "duration": 900,
            "status": "ok",
            "attrs": {
                "otel.span_kind": "client", "otel.scope": "@opentelemetry/instrumentation-pg",
                "db.system.name": "postgresql", "db.namespace": "shop", "server.address": "localhost",
                "server.port": 5432, "db.query.text": "SELECT * FROM users WHERE id = $1",
                "db.postgresql.values": [n.to_string()], "code.origin": "server.js:21 in <anonymous>",
            },
        })
    };
    let doc = serde_json::json!({
        "id": "01M4PGTRACE000000000000000", "kind": "http", "name": "GET /orders", "start": 1_791_000_000_000_000_i64,
        "duration": 5000, "status": "ok",
        "attrs": {"http.method": "GET", "http.route": "/orders", "http.status_code": 200, "service.name": "shop",
                  "telemetry.sdk.language": "nodejs"},
        "spans": [
            {"id": "01M4PGR00T0000000000000000", "parent_id": null, "kind": "http", "name": "GET /orders",
             "start": 1_791_000_000_000_000_i64, "duration": 5000, "status": "ok", "attrs": {}},
            lookup(1), lookup(2), lookup(3),
        ],
        "logs": [], "errors": [], "links": [], "issues": [],
    });
    let errors: Vec<String> = validator()
        .iter_errors(&doc)
        .map(|error| error.to_string())
        .collect();
    assert!(errors.is_empty(), "as sent: {errors:?}");
    let batch = Batch {
        frame: serde_json::to_vec(&vec![&doc]).unwrap(),
        max_traces: Some(1000),
        thresholds: Thresholds::default(),
    };
    let mut received = batch.decode().unwrap();
    for trace in &mut received {
        tracepanel_analysis::apply(trace, &batch.thresholds);
    }
    store.write(&received).unwrap();

    let (status, trace) = get(&router, "/api/traces/01M4PGTRACE000000000000000").await;
    assert_eq!(status, StatusCode::OK);
    let errors: Vec<String> = validator()
        .iter_errors(&trace)
        .map(|error| error.to_string())
        .collect();
    assert!(errors.is_empty(), "as served: {errors:?}");
    let spans: Vec<(&str, &str)> = trace["spans"]
        .as_array()
        .unwrap()
        .iter()
        .map(|span| {
            (
                span["kind"].as_str().unwrap(),
                span["name"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        spans,
        [
            ("http", "GET /orders"),
            ("sql", "SELECT users"),
            ("sql", "SELECT users"),
            ("sql", "SELECT users")
        ]
    );
    assert_eq!(kinds(&trace["issues"]), ["n+1"]);

    let (_, queries) = get(&router, "/api/calls?system=sql").await;
    let query = &queries["calls"][0];
    assert_eq!(query["template"], "SELECT * FROM users WHERE id = $1");
    assert_eq!(query["target"], "shop");
    assert_eq!(query["vendor"], "postgresql");
    assert_eq!(query["calls"], 3);
    assert_eq!(query["most_per_trace"], 3);
    let _ = std::fs::remove_dir_all(&dir);
}

/// Systems with no kind of their own (a graph database, a broker, an RPC system): the family's generic kind, their
/// own name kept, and with no code per system, a list of their own (`/api/calls?system=neo4j`), a place in the counts,
/// and N+1 issues from their family's rules.
#[tokio::test]
async fn any_system_is_listed_and_analyzed_by_its_family() {
    let dir = std::env::temp_dir().join(format!("tracepanel-any-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path = tracepanel_store_local::path_in(&dir);
    let mut store = Store::open(&path).unwrap();
    let router = tracepanel_server::router(Reader::new(&path), Activity::default());

    let otel = |n: usize, name: &str, attrs: Value| {
        let mut attrs = attrs;
        attrs["otel.span_kind"] = attrs
            .get("otel.span_kind")
            .cloned()
            .unwrap_or(Value::from("client"));
        attrs["code.origin"] = Value::from("app/views.py:30 in feed");
        serde_json::json!({
            "id": format!("01M4ANYSPAN{n:015}"), "parent_id": "01M4ANYR00T000000000000000", "kind": "otel",
            "name": name, "start": 1_791_000_000_000_100_i64 + n as i64 * 10, "duration": 900, "status": "ok",
            "attrs": attrs,
        })
    };
    let mut spans = vec![serde_json::json!({
        "id": "01M4ANYR00T000000000000000", "parent_id": null, "kind": "http", "name": "GET /feed",
        "start": 1_791_000_000_000_000_i64, "duration": 9000, "status": "ok", "attrs": {},
    })];
    for n in 1..=3 {
        spans.push(otel(n, "MATCH", serde_json::json!({
            "db.system.name": "neo4j", "db.operation.name": "MATCH", "db.namespace": "graph",
            "db.query.text": format!("MATCH (u:User {{id: {n}}}) RETURN u"), "server.address": "graph.local",
        })));
        spans.push(otel(10 + n, "orders publish", serde_json::json!({
            "otel.span_kind": "producer", "messaging.system": "nats", "messaging.destination.name": "orders",
        })));
        spans.push(otel(20 + n, "Users.get", serde_json::json!({
            "rpc.system": "thrift", "rpc.service": "Users", "rpc.method": "get", "server.address": "users.local",
        })));
    }
    let doc = serde_json::json!({
        "id": "01M4ANYTRACE00000000000000", "kind": "http", "name": "GET /feed", "start": 1_791_000_000_000_000_i64,
        "duration": 9000, "status": "ok",
        "attrs": {"http.method": "GET", "http.route": "/feed", "http.status_code": 200, "service.name": "shop"},
        "spans": spans, "logs": [], "errors": [], "links": [], "issues": [],
    });
    let batch = Batch {
        frame: serde_json::to_vec(&vec![&doc]).unwrap(),
        max_traces: Some(1000),
        thresholds: Thresholds::default(),
    };
    let mut received = batch.decode().unwrap();
    for trace in &mut received {
        tracepanel_analysis::apply(trace, &batch.thresholds);
    }
    store.write(&received).unwrap();

    let (_, trace) = get(&router, "/api/traces/01M4ANYTRACE00000000000000").await;
    let errors: Vec<String> = validator()
        .iter_errors(&trace)
        .map(|error| error.to_string())
        .collect();
    assert!(errors.is_empty(), "as served: {errors:?}");
    let mut kinds_of: Vec<&str> = trace["spans"]
        .as_array()
        .unwrap()
        .iter()
        .map(|span| span["kind"].as_str().unwrap())
        .collect();
    kinds_of.dedup();
    assert_eq!(
        kinds_of,
        [
            "http",
            "db",
            "messaging",
            "rpc",
            "db",
            "messaging",
            "rpc",
            "db",
            "messaging",
            "rpc"
        ]
    );
    let mut titles: Vec<&str> = trace["issues"]
        .as_array()
        .unwrap()
        .iter()
        .map(|issue| issue["title"].as_str().unwrap())
        .collect();
    titles.sort_unstable();
    assert_eq!(
        titles,
        [
            "N+1: 3 similar NATS messages · publish orders",
            "N+1: 3 similar Neo4j commands · MATCH",
            "N+1: 3 similar Thrift calls · Users/get",
        ]
    );

    let (status, neo4j) = get(&router, "/api/calls?system=neo4j").await;
    assert_eq!(status, StatusCode::OK);
    let row = &neo4j["calls"][0];
    assert_eq!(
        (
            row["system"].clone(),
            row["family"].clone(),
            row["target"].clone(),
            row["op"].clone(),
            row["calls"].clone()
        ),
        (
            Value::from("neo4j"),
            Value::from("datastore"),
            Value::from("graph"),
            Value::from("MATCH"),
            Value::from(3)
        )
    );
    assert_eq!(neo4j["calls"].as_array().unwrap().len(), 1);
    let (_, counts) = get(&router, "/api/counts").await;
    assert_eq!(
        counts["sections"]["systems"],
        serde_json::json!([
            {"system": "neo4j", "family": "datastore", "label": "Neo4j"},
            {"system": "nats", "family": "messaging", "label": "NATS"},
            {"system": "thrift", "family": "rpc", "label": "Thrift"},
        ])
    );
    let (_, values) = get(&router, "/api/values").await;
    assert_eq!(
        values["targets"],
        serde_json::json!({"nats": ["orders"], "neo4j": ["graph"], "thrift": ["Users"]})
    );
    let key = row["key"].as_str().unwrap();
    let (_, found) = get(&router, &format!("/api/traces?q=call:{key}")).await;
    assert_eq!(found["traces"][0]["id"], "01M4ANYTRACE00000000000000");
    let (_, rpc) = get(&router, "/api/calls?q=family:rpc%20op:GET").await;
    assert_eq!(rpc["calls"][0]["system"], "thrift");
    let _ = std::fs::remove_dir_all(&dir);
}

async fn get(router: &axum::Router, uri: &str) -> (StatusCode, Value) {
    let request = Request::get(uri).body(Body::empty()).unwrap();
    let response = router.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
}
