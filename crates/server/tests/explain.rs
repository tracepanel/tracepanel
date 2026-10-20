//! EXPLAIN through the app that recorded the query: the console asks the agent, the agent writes the statement and
//! sends it down the app's own connection, the app answers with the rows, and the agent reads the plan from them.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tower::ServiceExt;
use tracepanel_protocol::{Activity, Listener, PROTOCOL, Received, serve};
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

/// A request of `shop` with one SELECT, as an SDK records it.
fn request_with_a_query() -> Received {
    let doc = json!({
        "id": "01M4R1ER9RWER0QHV07BJDSZ7B", "kind": "http", "name": "GET /books", "start": 0, "duration": 10,
        "status": "ok", "attrs": {"service.name": "shop"}, "logs": [], "errors": [], "links": [], "issues": [],
        "spans": [
            {"id": "R", "parent_id": null, "kind": "http", "name": "GET /books", "start": 0, "duration": 10,
             "status": "ok", "attrs": {}},
            {"id": "Q", "parent_id": "R", "kind": "sql", "name": "SELECT books", "start": 1, "duration": 2,
             "status": "ok", "attrs": {"db.system": "postgresql", "db.statement": "SELECT * FROM books WHERE id = $1",
                                       "db.params": ["7"], "server.address": "localhost", "server.port": 5432,
                                       "db.namespace": "shop"}},
        ],
    });
    Received {
        trace: serde_json::from_value(doc.clone()).unwrap(),
        doc: doc.to_string(),
    }
}

#[tokio::test]
async fn a_query_is_explained_by_the_app_that_recorded_it() {
    let dir = std::env::temp_dir().join(format!("tracepanel-explain-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let path = tracepanel_store_local::path_in(&dir);
    Store::open(&path)
        .unwrap()
        .write(&[request_with_a_query()])
        .unwrap();
    let activity = Activity::default();
    let router = tracepanel_server::router(Reader::new(&path), activity.clone());
    let (status, before) = get(&router, "/api/capabilities").await;
    assert_eq!(
        (status, before),
        (
            StatusCode::OK,
            json!({"explain": false, "users": false, "profile": false, "request": false, "live_tasks": false})
        )
    );

    // The app: says it can explain, then answers the first request with PostgreSQL's plan.
    let listener = Listener::tcp("127.0.0.1:0").await.unwrap();
    let address = listener
        .address()
        .unwrap()
        .strip_prefix("tcp:")
        .unwrap()
        .to_owned();
    tokio::spawn(serve(
        listener,
        std::sync::Arc::new(|_| {}),
        activity.clone(),
    ));
    let mut app = BufReader::new(TcpStream::connect(&address).await.unwrap());
    let hello = json!({"protocol": PROTOCOL, "service": "shop", "capabilities": ["explain"]});
    app.get_mut()
        .write_all(format!("{hello}\n").as_bytes())
        .await
        .unwrap();
    let mut line = String::new();
    app.read_line(&mut line).await.unwrap();
    for _ in 0..200 {
        if activity.apps.can("explain") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let answering = tokio::spawn(async move {
        let mut length = [0u8; 4];
        app.read_exact(&mut length).await.unwrap();
        let mut frame = vec![0u8; u32::from_be_bytes(length) as usize];
        app.read_exact(&mut frame).await.unwrap();
        let asked: Value = serde_json::from_slice(&frame).unwrap();
        let rows = json!([
            ["Seq Scan on books  (cost=0.00..1.05 rows=1 width=40)"],
            ["  Filter: (id = 7)"]
        ]);
        let answer =
            json!({"answer": asked["id"], "columns": ["QUERY PLAN"], "rows": rows}).to_string();
        app.get_mut()
            .write_all(&(answer.len() as u32).to_be_bytes())
            .await
            .unwrap();
        app.get_mut().write_all(answer.as_bytes()).await.unwrap();
        (asked, app)
    });

    let (status, plan) = get(
        &router,
        "/api/explain?trace=01M4R1ER9RWER0QHV07BJDSZ7B&span=Q",
    )
    .await;
    let (asked, _app) = answering.await.unwrap();
    let (_, after) = get(&router, "/api/capabilities").await;

    assert_eq!(
        asked["explain"],
        json!({"sql": "EXPLAIN SELECT * FROM books WHERE id = $1", "params": ["7"], "vendor": "postgresql",
               "alias": "default", "server": "localhost", "port": 5432, "database": "shop", "analyze": false})
    );
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        plan,
        json!({"vendor": "postgresql", "alias": "default", "analyzed": false, "lines": [
            {"depth": 0, "text": "Seq Scan on books  (cost=0.00..1.05 rows=1 width=40)",
             "warning": "Sequential scan of books: no index is used"},
            {"depth": 1, "text": "Filter: (id = 7)", "warning": null},
        ]})
    );
    assert_eq!(
        after,
        json!({"explain": true, "users": false, "profile": false, "request": false, "live_tasks": false})
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn with_no_app_connected_explain_says_so() {
    let dir = std::env::temp_dir().join(format!("tracepanel-explain-none-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let path = tracepanel_store_local::path_in(&dir);
    Store::open(&path)
        .unwrap()
        .write(&[request_with_a_query()])
        .unwrap();
    let router = tracepanel_server::router(Reader::new(&path), Activity::default());

    let (status, answer) = get(
        &router,
        "/api/explain?trace=01M4R1ER9RWER0QHV07BJDSZ7B&span=Q",
    )
    .await;
    let (missing, _) = get(
        &router,
        "/api/explain?trace=01M4R1ER9RWER0QHV07BJDSZ7B&span=R",
    )
    .await;

    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        answer,
        json!({"error": "No app of service shop that can explain is connected."})
    );
    // Not a query: nothing to explain.
    assert_eq!(missing, StatusCode::NOT_FOUND);
    let _ = std::fs::remove_dir_all(&dir);
}
