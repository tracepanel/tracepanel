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
    let (status, calls) = get(&router, "/api/calls?q=host:127.0.0.1").await;
    assert_eq!(status, StatusCode::OK, "{calls}");
    let rows = calls["calls"].as_array().unwrap();
    let endpoints: Vec<(&str, &str, i64, i64)> = rows
        .iter()
        .map(|row| {
            (
                row["method"].as_str().unwrap(),
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

    let (_, none) = get(&router, "/api/calls?q=host:elsewhere.example").await;
    assert_eq!(none["calls"], serde_json::json!([]));

    // The same filters on every list of calls: the target (host:, db:), op:, failed:.
    let (status, posts) = get(&router, "/api/calls?q=op:get%20failed:false").await;
    assert_eq!(status, StatusCode::OK, "{posts}");
    assert_eq!(posts["calls"].as_array().unwrap().len(), rows.len());
    let (_, failed) = get(&router, "/api/calls?q=failed:true").await;
    assert_eq!(failed["calls"], serde_json::json!([]));
    let (_, writes) = get(&router, "/api/queries?q=op:insert").await;
    assert!(
        writes["queries"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["statement"].as_str().unwrap().starts_with("INSERT")),
        "{writes}"
    );

    // Redis used directly: its commands per key pattern, with why they ran.
    let (status, redis) = get(&router, "/api/redis?q=db:redis%20op:get%20via:direct").await;
    assert_eq!(status, StatusCode::OK, "{redis}");
    let commands: Vec<(&str, &str, &str, i64, i64)> = redis["redis"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| {
            (
                row["command"].as_str().unwrap(),
                row["template"].as_str().unwrap(),
                row["via"].as_str().unwrap(),
                row["calls"].as_i64().unwrap(),
                row["most_per_trace"].as_i64().unwrap(),
            )
        })
        .collect();
    assert_eq!(commands, [("GET", "likes:{id}", "direct", 4, 4)]);
    let (_, through_cache) = get(&router, "/api/redis?q=via:cache").await;
    assert_eq!(through_cache["redis"], serde_json::json!([]));
    let (status, cache) = get(&router, "/api/cache").await;
    assert_eq!(status, StatusCode::OK, "{cache}");

    let (status, found) = get(
        &router,
        &format!(
            "/api/traces?q=redis_call:{}",
            redis["redis"][0]["key"].as_str().unwrap()
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{found}");
    assert_eq!(found["traces"][0]["id"], "01M4R1ER9RWER0QHV07BJDSZ7B");

    // What the filter menus offer.
    let (_, values) = get(&router, "/api/values").await;
    assert_eq!(values["host"], serde_json::json!(["127.0.0.1"]));
    assert_eq!(values["redis"], serde_json::json!(["redis"]));

    let (status, counts) = get(&router, "/api/counts").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(counts["sections"]["calls"], true);
    assert_eq!(counts["sections"]["redis"], true);
    let (_, other) = get(&router, "/api/counts?service=api").await;
    assert_eq!(other["sections"]["calls"], false);
    assert_eq!(other["sections"]["redis"], false);
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
