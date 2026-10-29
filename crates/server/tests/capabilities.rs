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
    // `shop` profiles on request, memory too; `blog` the time only; `billing` says nothing of it; `admin`'s settings
    // profile every request, memory too.
    let mut apps = Vec::new();
    for (service, capabilities) in [
        ("shop", json!(["profile", "profile_memory", "request"])),
        ("blog", json!(["profile"])),
        ("billing", json!(["request"])),
        (
            "admin",
            json!([
                "profile",
                "profile_memory",
                "profile_all",
                "profile_memory_all"
            ]),
        ),
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
        if activity.apps.says("request", "billing")
            && activity.apps.says("profile", "shop")
            && activity.apps.says("profile", "blog")
            && activity.apps.says("profile_all", "admin")
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }

    let (_, any) = get(&router, "/api/capabilities").await;
    let (status, shop) = get(&router, "/api/capabilities?service=shop").await;
    let (_, blog) = get(&router, "/api/capabilities?service=blog").await;
    let (_, billing) = get(&router, "/api/capabilities?service=billing").await;
    let (_, admin) = get(&router, "/api/capabilities?service=admin").await;
    let (_, gone) = get(&router, "/api/capabilities?service=orders").await;

    assert_eq!(
        any,
        json!({"explain": false, "users": false, "profile": true, "profile_memory": true, "profile_all": true, "profile_memory_all": true, "request": true, "live_tasks": false})
    );

    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        shop,
        json!({"explain": false, "users": false, "profile": true, "profile_memory": true, "profile_all": false, "profile_memory_all": false, "request": true, "live_tasks": false})
    );

    assert_eq!(
        blog,
        json!({"explain": false, "users": false, "profile": true, "profile_memory": false, "profile_all": false, "profile_memory_all": false, "request": false, "live_tasks": false})
    );

    assert_eq!(
        billing,
        json!({"explain": false, "users": false, "profile": false, "profile_memory": false, "profile_all": false, "profile_memory_all": false, "request": true, "live_tasks": false})
    );

    assert_eq!(
        admin,
        json!({"explain": false, "users": false, "profile": true, "profile_memory": true, "profile_all": true, "profile_memory_all": true, "request": false, "live_tasks": false})
    );

    assert_eq!(
        gone,
        json!({"explain": false, "users": false, "profile": false, "profile_memory": false, "profile_all": false, "profile_memory_all": false, "request": false, "live_tasks": false})
    );
    drop(apps);
    let _ = std::fs::remove_dir_all(&dir);
}

async fn get_via(router: &axum::Router, uri: &str, via: &str) -> Value {
    let request = Request::get(uri)
        .header("Tracepanel-Console", via)
        .body(Body::empty())
        .unwrap();
    let response = router.clone().oneshot(request).await.unwrap();
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    serde_json::from_slice(&body).unwrap_or(Value::Null)
}

#[tokio::test]
async fn a_trace_is_explained_where_its_app_runs_explain_at_any_console() {
    let dir =
        std::env::temp_dir().join(format!("tracepanel-explain-by-app-{}", std::process::id()));
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
    // A Node BFF runs EXPLAIN down its connection; a Python API at its own console and down its connection; an older
    // app at its own console only.
    let mut apps = Vec::new();
    for hello in [
        json!({"protocol": PROTOCOL, "service": "library-bff", "capabilities": ["explain"]}),
        json!({"protocol": PROTOCOL, "service": "library-api", "capabilities": ["explain"], "console": ["explain"]}),
        json!({"protocol": PROTOCOL, "service": "library-admin", "console": ["explain"]}),
    ] {
        let mut app = BufReader::new(TcpStream::connect(&address).await.unwrap());
        app.get_mut()
            .write_all(format!("{hello}\n").as_bytes())
            .await
            .unwrap();
        let mut line = String::new();
        app.read_line(&mut line).await.unwrap();
        apps.push(app);
    }
    for _ in 0..200 {
        if activity.apps.says("explain", "library-bff")
            && activity.apps.says("explain", "library-api")
            && activity.apps.offers("explain", Some("library-admin"))
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let explains = |answer: Value| answer["explain"] == true;
    let at = |console: Option<&'static str>| {
        let router = router.clone();
        async move {
            let mut answers = Vec::new();
            for service in ["library-bff", "library-api", "library-admin"] {
                let uri = format!("/api/capabilities?service={service}");
                let answer = match console {
                    Some(via) => get_via(&router, &uri, via).await,
                    None => get(&router, &uri).await.1,
                };
                answers.push(explains(answer));
            }
            answers
        }
    };

    // Each trace has it where its app runs it for the agent, at every console (one app's console forwards another
    // app's to the agent); the admin app's own traces at its own console too, which runs it in its process.
    let agent = at(None).await;
    let bff = at(Some("library-bff")).await;
    let api = at(Some("library-api")).await;
    let admin = at(Some("library-admin")).await;

    assert_eq!(agent, [true, true, false]);
    assert_eq!(bff, [true, true, false]);
    assert_eq!(api, [true, true, false]);
    assert_eq!(admin, [true, true, true]);
    drop(apps);
    let _ = std::fs::remove_dir_all(&dir);
}
