//! An app's settings and versions: told once in its hello, served per app at `api/app`, kept after the app goes. What
//! its checks found: in a frame after the hello, once they ran.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tower::ServiceExt;
use tracepanel_protocol::{Activity, Listener, PROTOCOL, serve};
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

/// Asks until `done` holds of the answer: the agent takes the hello on its own task.
async fn until(router: &axum::Router, uri: &str, done: impl Fn(&Value) -> bool) -> Value {
    for _ in 0..200 {
        let (_, answer) = get(router, uri).await;
        if done(&answer) {
            return answer;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    get(router, uri).await.1
}

#[tokio::test]
async fn an_app_says_its_settings_and_versions_in_its_hello() {
    let dir = std::env::temp_dir().join(format!("tracepanel-app-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let path = tracepanel_store_local::path_in(&dir);
    Store::open(&path).unwrap();
    let activity = Activity::default();
    let router = tracepanel_server::router(Reader::new(&path), activity.clone());
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
    let (status, before) = get(&router, "/api/app?service=shop").await;

    let settings = json!({"DEBUG": "True", "SECRET_KEY": "********",
                          "DATABASES": "{'default': {'NAME': 'shop', 'PASSWORD': ********}}"});
    let versions = json!([
        {"name": "Python", "version": "3.13.1", "kind": "runtime"},
        {"name": "Django", "version": "5.2.7", "kind": "framework"},
        {"name": "tracepanel", "version": "0.4.2", "kind": "package"},
    ]);
    let mut app = BufReader::new(TcpStream::connect(&address).await.unwrap());
    let hello = json!({"protocol": PROTOCOL, "service": "shop",
                       "app": {"settings": settings, "versions": versions}});
    app.get_mut()
        .write_all(format!("{hello}\n").as_bytes())
        .await
        .unwrap();
    let mut line = String::new();
    app.read_line(&mut line).await.unwrap();
    let told = until(&router, "/api/app?service=shop", |answer| {
        answer["connected"] == true
    })
    .await;
    let checks = json!([{"id": "security.W004", "level": "warning",
                         "message": "You have not set a value for the SECURE_HSTS_SECONDS setting.",
                         "hint": null, "object": null}]);
    let migrations = json!({"unapplied": [{"app": "shop", "names": ["0002_order_note"]}],
                            "changes": [{"app": "shop", "changes": ["Add field gift to order"]}]});
    let frame = json!({"app": {"checks": checks, "migrations": migrations}}).to_string();
    app.get_mut()
        .write_all(&(frame.len() as u32).to_be_bytes())
        .await
        .unwrap();
    app.get_mut().write_all(frame.as_bytes()).await.unwrap();
    let checked = until(&router, "/api/app?service=shop", |answer| {
        answer["checks"].is_array()
    })
    .await;
    drop(app);
    let gone = until(&router, "/api/app?service=shop", |answer| {
        answer["connected"] == false
    })
    .await;
    let (_, other) = get(&router, "/api/app?service=shop-web").await;

    let agent = env!("CARGO_PKG_VERSION");
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        before,
        json!({"service": "shop", "agent": agent, "connected": false, "received": null, "settings": null,
               "versions": null, "checks": null, "migrations": null, "migrate": null})
    );

    assert_eq!(
        told,
        json!({"service": "shop", "agent": agent, "connected": true, "received": told["received"],
               "settings": settings, "versions": versions, "checks": null, "migrations": null, "migrate": null})
    );
    assert!(told["received"].as_i64().unwrap() > 0);

    // The checks ran after the hello: their frame adds what they found.
    assert_eq!(
        checked,
        json!({"service": "shop", "agent": agent, "connected": true, "received": checked["received"],
               "settings": settings, "versions": versions, "checks": checks, "migrations": migrations, "migrate": null})
    );

    // The app went: what it said stays, for the console of an app that restarts or stopped.
    assert_eq!(
        gone,
        json!({"service": "shop", "agent": agent, "connected": false, "received": checked["received"],
               "settings": settings, "versions": versions, "checks": checks, "migrations": migrations, "migrate": null})
    );

    // An app whose SDK doesn't say (JavaScript, Java): nulls, and the agent's version.
    assert_eq!(
        other,
        json!({"service": "shop-web", "agent": agent, "connected": false, "received": null, "settings": null,
               "versions": null, "checks": null, "migrations": null, "migrate": null})
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_trace_not_stored_yet_is_no_error_to_a_client_that_waits_for_it() {
    let dir = std::env::temp_dir().join(format!("tracepanel-not-yet-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let path = tracepanel_store_local::path_in(&dir);
    Store::open(&path).unwrap();
    let router = tracepanel_server::router(Reader::new(&path), Activity::default());
    let id = "01M6660HQFP6QW4T4SE7SJW7N9";

    let (gone, _) = get(&router, &format!("/api/traces/{id}")).await;
    let (waited, body) = get(&router, &format!("/api/traces/{id}?missing=no-content")).await;

    assert_eq!(gone, StatusCode::NOT_FOUND);
    assert_eq!((waited, body), (StatusCode::NO_CONTENT, Value::Null));
    let _ = std::fs::remove_dir_all(&dir);
}
