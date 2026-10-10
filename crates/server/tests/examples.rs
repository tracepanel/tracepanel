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
    let dir = std::env::temp_dir().join(format!("tracepanel-examples-{}", std::process::id()));
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
    let _ = std::fs::remove_dir_all(&dir);
}
