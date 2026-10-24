//! What the console can offer, asked for one app: what a connected app of that service said in its hello, and
//! nothing for an app that isn't connected or didn't say it.

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

#[tokio::test]
async fn an_apps_capabilities_are_its_own() {
    let dir = std::env::temp_dir().join(format!("tracepanel-capabilities-{}", std::process::id()));
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
    // `shop` profiles on request; `billing` says nothing of it.
    let mut apps = Vec::new();
    for (service, capabilities) in [
        ("shop", json!(["profile", "request"])),
        ("billing", json!(["request"])),
    ] {
        let mut app = BufReader::new(TcpStream::connect(&address).await.unwrap());
        let hello = json!({"protocol": PROTOCOL, "service": service, "capabilities": capabilities});
        app.get_mut()
            .write_all(format!("{hello}\n").as_bytes())
            .await
            .unwrap();
        let mut line = String::new();
        app.read_line(&mut line).await.unwrap();
        apps.push(app);
    }
    for _ in 0..200 {
        if activity.apps.says("request", "billing") && activity.apps.says("profile", "shop") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }

    let (_, any) = get(&router, "/api/capabilities").await;
    let (status, shop) = get(&router, "/api/capabilities?service=shop").await;
    let (_, billing) = get(&router, "/api/capabilities?service=billing").await;
    let (_, gone) = get(&router, "/api/capabilities?service=orders").await;

    assert_eq!(
        any,
        json!({"explain": false, "users": false, "profile": true, "request": true, "live_tasks": false})
    );

    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        shop,
        json!({"explain": false, "users": false, "profile": true, "request": true, "live_tasks": false})
    );

    assert_eq!(
        billing,
        json!({"explain": false, "users": false, "profile": false, "request": true, "live_tasks": false})
    );

    assert_eq!(
        gone,
        json!({"explain": false, "users": false, "profile": false, "request": false, "live_tasks": false})
    );
    drop(apps);
    let _ = std::fs::remove_dir_all(&dir);
}
