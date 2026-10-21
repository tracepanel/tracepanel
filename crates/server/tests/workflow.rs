//! A task run's workflow through the console's API: its related traces say the steps before and after it, its root
//! and its group, and `group:` finds the group's runs.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::{Value, json};
use tower::ServiceExt;
use tracepanel_protocol::{Activity, Received};
use tracepanel_store_local::{Reader, Store};

async fn get(router: &axum::Router, uri: &str) -> (StatusCode, Value) {
    let request = Request::get(uri).body(Body::empty()).unwrap();
    let response = router.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
}

/// The trace id of a run: `01M4W0RKF10W` and its letter, padded to 26.
fn id(letter: &str) -> String {
    format!("01M4W0RKF10W{letter:0>14}")
}

/// A Celery run with these attributes, sent from inside the run `by` when it was.
fn run(letter: &str, start: i64, attrs: Value, by: Option<&str>) -> Received {
    let links: Vec<Value> = by
        .map(|by| json!({"kind": "enqueued_by", "trace_id": id(by), "span_id": "SPAN"}))
        .into_iter()
        .collect();
    let mut all = json!({"service.name": "shop", "task.system": "celery", "task.state": "SUCCESS"});
    all.as_object_mut()
        .unwrap()
        .extend(attrs.as_object().unwrap().clone());
    let doc = json!({
        "id": id(letter), "kind": "task", "name": "shop.tasks.resize", "start": start, "duration": 1000,
        "status": "ok", "attrs": all, "spans": [], "logs": [], "errors": [], "links": links, "issues": [],
    });
    Received {
        trace: serde_json::from_value(doc.clone()).unwrap(),
        doc: doc.to_string(),
    }
}

#[tokio::test]
async fn a_runs_related_traces_say_its_workflow() {
    let dir =
        std::env::temp_dir().join(format!("tracepanel-server-workflow-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let path = tracepanel_store_local::path_in(&dir);
    let member = |task: &str| json!({"task.id": task, "task.group_id": "g", "task.parent_id": "a", "task.root_id": "a"});
    // A fans out a group of two; C, its chord's callback, follows the last of them.
    Store::open(&path)
        .unwrap()
        .write(&[
            run("A", 1, json!({"task.id": "a"}), None),
            run("B1", 2, member("b1"), Some("A")),
            run("B2", 3, member("b2"), Some("A")),
            run(
                "C",
                4,
                json!({"task.id": "c", "task.parent_id": "b2", "task.root_id": "a", "task.group_id": "g"}),
                Some("B2"),
            ),
        ])
        .unwrap();
    let router = tracepanel_server::router(Reader::new(&path), Activity::default());

    let (status, related) = get(&router, &format!("/api/traces/{}/related", id("C"))).await;
    let (_, first) = get(&router, &format!("/api/traces/{}/related", id("A"))).await;
    let (_, found) = get(&router, "/api/traces?q=group:g").await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(related["enqueued_by"]["id"], id("B2"));
    let workflow = &related["workflow"];
    assert_eq!(
        (
            &workflow["task_id"],
            &workflow["runs"],
            &workflow["root"]["id"]
        ),
        (
            &json!("c"),
            &json!({"b2": id("B2"), "a": id("A")}),
            &json!(id("A"))
        )
    );
    // B2 is its enqueued_by: listed there, not again.
    assert_eq!(
        (&workflow["follows"], &workflow["followed_by"]),
        (&json!([]), &json!([]))
    );
    assert_eq!(
        (
            &workflow["group"]["id"],
            &workflow["group"]["tasks"],
            &workflow["group"]["runs"][0]["id"]
        ),
        (&json!("g"), &json!(2), &json!(id("B1")))
    );

    // The first run enqueued the group's tasks: they are its enqueued, and it is their root.
    assert_eq!(
        first["enqueued"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| &item["id"])
            .collect::<Vec<_>>(),
        [&json!(id("B1")), &json!(id("B2"))]
    );
    assert_eq!(first["workflow"]["followed_by"], json!([]));

    // The group's tasks, newest first: not the callback that follows them.
    let ids: Vec<&str> = found["traces"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, [id("B2"), id("B1")]);
    let _ = std::fs::remove_dir_all(&dir);
}
