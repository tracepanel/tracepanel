//! A trace's profile, as the SDKs send it: the first form (stacks and their counts) and the one that says when each
//! stack was seen, which samples waited and how many weren't taken. Both match the schema, are stored whole and come
//! back from the console's API as they were sent.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::{Value, json};
use std::path::Path;
use tower::ServiceExt;
use tracepanel_protocol::{Activity, Batch, Thresholds};
use tracepanel_store_local::{Reader, Store};

fn validator() -> jsonschema::Validator {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../schema/trace.schema.json");
    let schema: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    jsonschema::validator_for(&schema).unwrap()
}

fn errors(validator: &jsonschema::Validator, doc: &Value) -> Vec<String> {
    validator
        .iter_errors(doc)
        .map(|error| error.to_string())
        .collect()
}

/// A task of `id` whose profile is `profile`.
fn task(id: &str, profile: Value) -> Value {
    json!({
        "id": id, "kind": "task", "name": "app.handlers.build_sales_report", "start": 1_000_000,
        "duration": 1_600_000, "status": "ok", "attrs": {"service.name": "shop"}, "logs": [], "errors": [],
        "links": [], "issues": [],
        "spans": [{"id": "01M4R1ER9RWER0QHV07BJDSZ7R", "parent_id": null, "kind": "task.run", "name": "app.handlers.build_sales_report",
                   "start": 1_000_000, "duration": 1_600_000, "status": "ok", "attrs": {}}],
        "profile": profile,
    })
}

fn first_form() -> Value {
    json!({
        "interval_us": 1000, "samples": 2,
        "frames": [{"function": "build_sales_report", "module": "app.handlers", "file": "app/handlers.py",
                    "line": 100, "in_app": true}],
        "stacks": [{"frames": [0], "count": 2}],
    })
}

fn timed() -> Value {
    json!({
        "interval_us": 10000, "samples": 110, "dropped": 50, "bucket_us": 10000,
        "frames": [
            {"function": "build_sales_report", "module": "app.handlers", "file": "app/handlers.py", "line": 100,
             "in_app": true, "at_line": 108},
            {"function": "sleep", "module": "asyncio.tasks", "file": "asyncio/tasks.py", "line": 640,
             "in_app": false, "waiting": true},
        ],
        "stacks": [
            {"frames": [0], "count": 10, "at": [[0, 4], [1, 6]]},
            {"frames": [0, 1], "count": 100, "at": [[2, 50], [3, 50]]},
        ],
    })
}

#[test]
fn both_forms_of_a_profile_match_the_schema_and_a_broken_one_does_not() {
    let validator = validator();
    let mut half_a_pair = timed();
    half_a_pair["stacks"][0]["at"] = json!([[0]]);
    let mut negative = timed();
    negative["dropped"] = json!(-1);

    assert_eq!(
        errors(
            &validator,
            &task("01M4R1ER9RWER0QHV07BJDSZ70", first_form())
        ),
        Vec::<String>::new()
    );
    assert_eq!(
        errors(&validator, &task("01M4R1ER9RWER0QHV07BJDSZ71", timed())),
        Vec::<String>::new()
    );

    assert!(!errors(&validator, &task("01M4R1ER9RWER0QHV07BJDSZ72", half_a_pair)).is_empty());
    assert!(!errors(&validator, &task("01M4R1ER9RWER0QHV07BJDSZ73", negative)).is_empty());
}

#[tokio::test]
async fn a_timed_profile_comes_back_from_the_api_as_it_was_sent() {
    let validator = validator();
    let dir = std::env::temp_dir().join(format!("tracepanel-profile-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path = tracepanel_store_local::path_in(&dir);
    let mut store = Store::open(&path).unwrap();
    let router = tracepanel_server::router(Reader::new(&path), Activity::default());
    let docs = [
        task("01M4R1ER9RWER0QHV07BJDSZ70", first_form()),
        task("01M4R1ER9RWER0QHV07BJDSZ71", timed()),
    ];
    let batch = Batch {
        frame: serde_json::to_vec(&docs).unwrap(),
        max_traces: Some(10),
        thresholds: Thresholds::default(),
    };
    store.write(&batch.decode().unwrap()).unwrap();

    let mut answers = Vec::new();
    for doc in &docs {
        let request = Request::get(format!("/api/traces/{}", doc["id"].as_str().unwrap()))
            .body(Body::empty())
            .unwrap();
        let response = router.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        answers.push(serde_json::from_slice::<Value>(&body).unwrap());
    }

    assert_eq!(answers[0]["profile"], first_form());
    assert_eq!(answers[1]["profile"], timed());

    assert_eq!(errors(&validator, &answers[1]), Vec::<String>::new());
    let _ = std::fs::remove_dir_all(&dir);
}
