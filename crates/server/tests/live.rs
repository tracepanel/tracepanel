//! Tasks in flight, from the wire to the console: an app says it sends task events, sends them on its connection as a
//! frame that is an object, and `api/tasks/live` lists the tasks until they finish.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tower::ServiceExt;
use tracepanel_protocol::{Activity, Listener, PROTOCOL, serve};
use tracepanel_store_local::Reader;

async fn get(router: &axum::Router, uri: &str) -> (StatusCode, Value) {
    let request = Request::get(uri).body(Body::empty()).unwrap();
    let response = router.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
}

async fn send(app: &mut BufReader<TcpStream>, frame: &Value) {
    let body = frame.to_string();
    app.get_mut()
        .write_all(&(body.len() as u32).to_be_bytes())
        .await
        .unwrap();
    app.get_mut().write_all(body.as_bytes()).await.unwrap();
}

/// `api/tasks/live` once `ready` holds for it (the agent reads frames on its own task).
async fn live_when(router: &axum::Router, ready: impl Fn(&Value) -> bool) -> Value {
    for _ in 0..200 {
        let (status, live) = get(router, "/api/tasks/live").await;
        assert_eq!(status, StatusCode::OK);
        if ready(&live) {
            return live;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("api/tasks/live never got there");
}

#[tokio::test]
async fn task_events_on_the_wire_are_listed_until_the_task_finishes() {
    let dir = std::env::temp_dir().join(format!("tracepanel-live-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path = tracepanel_store_local::path_in(&dir);
    // An empty store: the counts come from it.
    tracepanel_store_local::Store::open(&path).unwrap();
    let activity = Activity::default();
    let router = tracepanel_server::router(Reader::new(&path), activity.clone());
    let listener = Listener::tcp("127.0.0.1:0").await.unwrap();
    let address = listener.address().unwrap().replace("tcp:", "");
    let received = std::sync::Arc::new(std::sync::Mutex::new(0));
    let sink = {
        let received = received.clone();
        std::sync::Arc::new(move |_| *received.lock().unwrap() += 1)
    };
    tokio::spawn(serve(listener, sink, activity.clone()));

    let (status, empty) = get(&router, "/api/tasks/live").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        empty,
        json!({"now": empty["now"], "tasks": [], "workers": []})
    );

    let (_, counts) = get(&router, "/api/counts").await;
    assert_eq!(counts["live_tasks"], false);

    let mut app = BufReader::new(TcpStream::connect(&address).await.unwrap());
    let hello = json!({"protocol": PROTOCOL, "service": "shop", "capabilities": ["live_tasks"]});
    app.get_mut()
        .write_all(format!("{hello}\n").as_bytes())
        .await
        .unwrap();
    let mut line = String::new();
    app.read_line(&mut line).await.unwrap();
    let start = tracepanel_protocol::live::now_us();
    send(
        &mut app,
        &json!({"tasks": [
            {"event": "enqueued", "system": "celery", "id": "t1", "name": "shop.mail", "time": start,
             "queue": "celery", "trace_id": "01M4R1ER9RWER0QHV07BJDSZ7B", "span_id": "S"},
            {"event": "started", "system": "celery", "id": "t2", "name": "shop.report", "time": start + 1,
             "queue": "celery", "worker": "celery@box", "retries": 0, "args": "(7,)", "kwargs": "{}"},
        ]}),
    )
    .await;

    let live = live_when(&router, |live| live["tasks"].as_array().unwrap().len() == 2).await;
    let (_, capabilities) = get(&router, "/api/capabilities").await;
    let (_, counts) = get(&router, "/api/counts").await;
    let (_, blog) = get(&router, "/api/counts?service=blog").await;

    assert_eq!(
        live["tasks"],
        json!([
            {"id": "t2", "system": "celery", "name": "shop.report", "service": "shop", "state": "running",
             "queue": "celery", "worker": "celery@box", "enqueued_at": null, "started_at": start + 1, "retries": 0,
             "args": "(7,)", "kwargs": "{}", "error": null, "enqueued_by": null},
            {"id": "t1", "system": "celery", "name": "shop.mail", "service": "shop", "state": "queued",
             "queue": "celery", "worker": null, "enqueued_at": start, "started_at": null, "retries": 0,
             "args": null, "kwargs": null, "error": null,
             "enqueued_by": {"trace_id": "01M4R1ER9RWER0QHV07BJDSZ7B", "span_id": "S"}},
        ])
    );
    assert_eq!(
        live["workers"],
        json!([{"name": "celery@box", "system": "celery", "service": "shop", "last_seen": live["workers"][0]["last_seen"], "in_flight": 1}])
    );
    assert_eq!(capabilities["live_tasks"], true);
    // Tasks shows before any task's trace is stored: for this app, not another.
    assert_eq!(
        (
            counts["live_tasks"].clone(),
            counts["sections"]["tasks"].clone()
        ),
        (json!(true), json!(0))
    );
    assert_eq!(blog["live_tasks"], false);
    // Task events are no traces: nothing reached the store's queue.
    assert_eq!(*received.lock().unwrap(), 0);

    send(
        &mut app,
        &json!({"tasks": [{"event": "finished", "system": "celery", "id": "t2", "time": start + 2, "worker": "celery@box"}]}),
    )
    .await;
    let live = live_when(&router, |live| live["tasks"].as_array().unwrap().len() == 1).await;
    let (_, other) = get(&router, "/api/tasks/live?service=blog").await;

    assert_eq!(live["tasks"][0]["id"], "t1");
    // t1 waits in the queue the worker took t2 from: it is between two tasks, not idle.
    assert_eq!(live["workers"][0]["in_flight"], 1);
    assert_eq!(other["tasks"], json!([]));

    // The worker stops cleanly and says so: it leaves at once.
    send(
        &mut app,
        &json!({"tasks": [{"event": "worker_stopped", "system": "celery", "time": start + 3, "worker": "celery@box"}]}),
    )
    .await;
    let live = live_when(&router, |live| live["workers"] == json!([])).await;

    assert_eq!(live["tasks"][0]["id"], "t1");
    let _ = std::fs::remove_dir_all(&dir);
}
