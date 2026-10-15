//! Another project's agent on this machine served a call of this one's app: asked by the W3C ids the call carried,
//! with the token its registry entry gives, it names its trace, and the call's relations list it with its console.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::{Value, json};
use tower::ServiceExt;
use tracepanel_protocol::{Activity, Received};
use tracepanel_store_local::{Reader, Store};

const W3C_TRACE: &str = "4bf92f3577b34da6a3ce929d0e0e4736";
const W3C_SPAN: &str = "00f067aa0ba902b7";

fn received(doc: Value) -> Received {
    Received {
        trace: serde_json::from_value(doc.clone()).unwrap(),
        doc: doc.to_string(),
    }
}

/// The shop's request, calling the orders service with the W3C ids.
fn caller() -> Received {
    received(json!({
        "id": "01M4R1ER9RWER0QHV07BJDSZ7A", "kind": "http", "name": "POST /checkout", "start": 0, "duration": 50,
        "status": "ok", "attrs": {"service.name": "shop", "w3c.trace_id": W3C_TRACE},
        "logs": [], "errors": [], "links": [], "issues": [],
        "spans": [
            {"id": "R", "parent_id": null, "kind": "http", "name": "POST /checkout", "start": 0, "duration": 50,
             "status": "ok", "attrs": {}},
            {"id": "C", "parent_id": "R", "kind": "http.client", "name": "POST orders/orders", "start": 5,
             "duration": 30, "status": "ok", "attrs": {"http.method": "POST", "server.address": "127.0.0.1",
             "server.port": 9100, "url.full": "http://127.0.0.1:9100/orders", "w3c.span_id": W3C_SPAN}},
        ],
    }))
}

/// The orders service's request that served it, in its own project's store.
fn callee() -> Received {
    received(json!({
        "id": "01M4R1ER9RWER0QHV07BJDSZ7B", "kind": "http", "name": "POST /orders", "start": 10, "duration": 20,
        "status": "ok", "attrs": {"service.name": "orders", "w3c.trace_id": W3C_TRACE, "w3c.parent_span_id": W3C_SPAN,
                                  "http.method": "POST", "http.path": "/orders", "http.route": "/orders"},
        "logs": [], "errors": [], "links": [], "issues": [],
        "spans": [{"id": "R", "parent_id": null, "kind": "http", "name": "POST /orders", "start": 10, "duration": 20,
                   "status": "ok", "attrs": {}}],
    }))
}

fn store(name: &str, traces: &[Received]) -> std::path::PathBuf {
    let dir = std::env::temp_dir()
        .join(format!(
            "tracepanel-neighbours-{}-{name}",
            std::process::id()
        ))
        .join(".tracepanel");
    let _ = std::fs::remove_dir_all(&dir);
    let path = tracepanel_store_local::path_in(&dir);
    Store::open(&path).unwrap().write(traces).unwrap();
    path
}

async fn get(router: &axum::Router, uri: &str) -> (StatusCode, Value) {
    let response = router
        .clone()
        .oneshot(Request::get(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
}

#[tokio::test]
async fn a_call_another_projects_app_served_is_listed_with_that_projects_console() {
    let cache = std::env::temp_dir().join(format!(
        "tracepanel-neighbours-cache-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&cache);
    // SAFETY: this test file sets it before any thread reads it, and its only test runs alone in its process.
    unsafe { std::env::set_var("TRACEPANEL_CACHE_DIR", &cache) };
    let token = tracepanel_server::neighbors::token();
    tracepanel_server::identify(token.clone(), "http://127.0.0.1:1/".to_owned());

    // The orders project's agent, serving its console, registered as a neighbour.
    let orders = store("orders", &[callee()]);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let console = format!("http://{}/", listener.local_addr().unwrap());
    let neighbour = tracepanel_server::router(Reader::new(&orders), Activity::default());
    tokio::spawn(axum::serve(listener, neighbour.clone()).into_future());
    std::fs::create_dir_all(cache.join("agents")).unwrap();
    std::fs::write(
        cache.join("agents").join("orders.json"),
        json!({"pid": 1, "dir": orders.parent().unwrap(), "console": console, "token": token})
            .to_string(),
    )
    .unwrap();

    let shop = tracepanel_server::router(
        Reader::new(&store("shop", &[caller()])),
        Activity::default(),
    );
    let (status, related) = get(&shop, "/api/traces/01M4R1ER9RWER0QHV07BJDSZ7A/related").await;
    let (refused, _) = get(
        &neighbour,
        &format!("/api/w3c?trace={W3C_TRACE}&span={W3C_SPAN}"),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    let remote = &related["remote_calls"];
    assert_eq!(remote.as_array().map(Vec::len), Some(1), "{related}");
    assert_eq!(remote[0]["span_id"], "C");
    assert_eq!(remote[0]["trace"]["id"], "01M4R1ER9RWER0QHV07BJDSZ7B");
    assert_eq!(remote[0]["console"], console.as_str());
    assert_eq!(
        remote[0]["project"],
        format!("tracepanel-neighbours-{}-orders", std::process::id())
    );
    // Without the registry's token, a neighbour says nothing.
    assert_eq!(refused, StatusCode::FORBIDDEN);
    let _ = std::fs::remove_dir_all(&cache);
}
