//! The wire, from an SDK's side: a hello line answered yes or no, then length-prefixed frames that reach the sink with
//! the SDK's settings; a frame too large, or a protocol the agent doesn't speak, ends the connection.

use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tracepanel_protocol::{Activity, Batch, Listener, PROTOCOL, serve};

/// An agent on a free TCP port; what its sink receives.
async fn agent() -> (String, Arc<Mutex<Vec<Batch>>>, Activity) {
    let listener = Listener::tcp("127.0.0.1:0").await.unwrap();
    let address = listener.address().unwrap();
    let received = Arc::new(Mutex::new(Vec::new()));
    let activity = Activity::default();
    let sink = {
        let received = received.clone();
        Arc::new(move |batch: Batch| received.lock().unwrap().push(batch))
    };
    tokio::spawn(serve(listener, sink, activity.clone()));
    (
        address.strip_prefix("tcp:").unwrap().to_owned(),
        received,
        activity,
    )
}

/// Connects and says hello; returns the stream and the agent's answer.
async fn hello(
    address: &str,
    hello: serde_json::Value,
) -> (BufReader<TcpStream>, serde_json::Value) {
    let mut stream = BufReader::new(TcpStream::connect(address).await.unwrap());
    stream
        .get_mut()
        .write_all(format!("{hello}\n").as_bytes())
        .await
        .unwrap();
    let mut line = String::new();
    stream.read_line(&mut line).await.unwrap();
    (stream, serde_json::from_str(&line).unwrap())
}

async fn send(stream: &mut BufReader<TcpStream>, frame: &[u8]) {
    let length = u32::try_from(frame.len()).unwrap();
    stream
        .get_mut()
        .write_all(&length.to_be_bytes())
        .await
        .unwrap();
    stream.get_mut().write_all(frame).await.unwrap();
}

/// Until the sink has `count` batches (the agent reads on its own task).
async fn wait_for(received: &Arc<Mutex<Vec<Batch>>>, count: usize) {
    for _ in 0..200 {
        if received.lock().unwrap().len() >= count {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!(
        "the sink got {} batches, not {count}",
        received.lock().unwrap().len()
    );
}

#[tokio::test]
async fn frames_reach_the_sink_with_the_sdks_settings() {
    let (address, received, activity) = agent().await;
    let settings = serde_json::json!({
        "protocol": PROTOCOL,
        "max_traces": 50,
        "thresholds": {"n_plus_one": 5, "slow_sql_ms": 20, "long_transaction_ms": 900},
    });
    let (mut stream, answer) = hello(&address, settings).await;

    assert_eq!(answer, serde_json::json!({"ok": true}));
    // An SDK connected: the agent is in use, however long ago the last frame came.
    assert_eq!(activity.idle_seconds(), 0);

    send(&mut stream, br#"[{"id": "a"}]"#).await;
    send(&mut stream, br#"[{"id": "b"}, {"id": "c"}]"#).await;
    wait_for(&received, 2).await;

    let batches = received.lock().unwrap();
    assert_eq!(batches[1].frame, br#"[{"id": "b"}, {"id": "c"}]"#);
    assert_eq!(batches[0].max_traces, Some(50));
    let thresholds = batches[0].thresholds;
    assert_eq!(
        (
            thresholds.n_plus_one,
            thresholds.slow_sql_ms,
            thresholds.long_transaction_ms,
            thresholds.slow_http_ms
        ),
        // An SDK that doesn't know a threshold yet gets its default.
        (5, 20, 900, 500)
    );
}

#[tokio::test]
async fn without_settings_the_defaults() {
    let (address, received, _) = agent().await;
    let (mut stream, _) = hello(&address, serde_json::json!({"protocol": PROTOCOL})).await;

    send(&mut stream, b"[]").await;
    wait_for(&received, 1).await;

    let batches = received.lock().unwrap();
    let thresholds = batches[0].thresholds;
    assert_eq!(batches[0].max_traces, None);
    assert_eq!(
        (
            thresholds.n_plus_one,
            thresholds.slow_sql_ms,
            thresholds.long_transaction_ms,
            thresholds.slow_http_ms
        ),
        (3, 100, 500, 500)
    );
}

#[tokio::test]
async fn another_protocol_is_refused_with_the_reason() {
    let (address, received, _) = agent().await;
    let (mut stream, answer) = hello(&address, serde_json::json!({"protocol": PROTOCOL + 1})).await;

    assert_eq!(
        answer,
        serde_json::json!({"ok": false, "error": format!("protocol {PROTOCOL} expected, got {}", PROTOCOL + 1)})
    );
    // Refused: the agent hangs up, and nothing reaches the sink.
    let mut rest = Vec::new();
    stream.read_to_end(&mut rest).await.unwrap();
    assert!(rest.is_empty());
    assert!(received.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_frame_too_large_ends_the_connection() {
    let (address, received, _) = agent().await;
    let (mut stream, _) = hello(&address, serde_json::json!({"protocol": PROTOCOL})).await;

    // A length over the limit (64 MiB): the agent closes rather than allocate it.
    stream
        .get_mut()
        .write_all(&(65u32 << 20).to_be_bytes())
        .await
        .unwrap();
    let mut rest = Vec::new();
    stream.read_to_end(&mut rest).await.unwrap();

    assert!(received.lock().unwrap().is_empty());
}

#[tokio::test]
async fn an_agent_answers_where_it_listens_and_not_elsewhere() {
    let (address, _, _) = agent().await;

    assert!(tracepanel_protocol::answers(&format!("tcp:{address}")));
    assert!(!tracepanel_protocol::answers("tcp:127.0.0.1:9"));
    assert!(!tracepanel_protocol::answers("udp:somewhere"));
}

#[tokio::test]
async fn an_app_that_can_explain_answers_the_agents_request_down_its_own_connection() {
    let (address, received, activity) = agent().await;
    let (mut stream, answer) = hello(
        &address,
        serde_json::json!({"protocol": PROTOCOL, "service": "shop", "capabilities": ["explain"]}),
    )
    .await;
    assert_eq!(answer["ok"], true);
    // The agent has the app once the hello is read.
    for _ in 0..200 {
        if activity.apps.can("explain") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let apps = activity.apps.clone();
    let asked = tokio::spawn(async move {
        apps.ask(
            "shop",
            "explain",
            serde_json::json!({"explain": {"sql": "EXPLAIN SELECT 1", "params": []}}),
            Duration::from_secs(5),
        )
        .await
    });

    // The app reads the request as a frame and answers with an object frame.
    let mut length = [0u8; 4];
    stream.read_exact(&mut length).await.unwrap();
    let mut frame = vec![0u8; u32::from_be_bytes(length) as usize];
    stream.read_exact(&mut frame).await.unwrap();
    let request: serde_json::Value = serde_json::from_slice(&frame).unwrap();
    let reply = serde_json::json!({"answer": request["id"], "columns": ["QUERY PLAN"], "rows": [["Result"]]});
    send(&mut stream, reply.to_string().as_bytes()).await;
    let answer = asked.await.unwrap().unwrap();

    assert_eq!(request["explain"]["sql"], "EXPLAIN SELECT 1");
    assert_eq!(answer["rows"], serde_json::json!([["Result"]]));
    // An answer is no traces.
    assert!(received.lock().unwrap().is_empty());

    drop(stream);
    for _ in 0..200 {
        if !activity.apps.can("explain") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(!activity.apps.can("explain"));
}

#[tokio::test]
async fn nothing_connected_can_explain_says_so() {
    let (_, _, activity) = agent().await;

    let asked = activity
        .apps
        .ask(
            "shop",
            "explain",
            serde_json::json!({}),
            Duration::from_millis(100),
        )
        .await;

    assert_eq!(
        asked,
        Err("No app of service shop that can explain is connected.".to_owned())
    );
}

#[tokio::test]
async fn what_an_app_answers_at_its_own_console_is_offered_only_to_the_console_it_serves() {
    let (address, _, activity) = agent().await;
    let (stream, answer) = hello(
        &address,
        serde_json::json!({
            "protocol": PROTOCOL,
            "service": "shop",
            "capabilities": ["profile", "request"],
            "console": ["explain", "users"],
        }),
    )
    .await;
    assert_eq!(answer["ok"], true);
    for _ in 0..200 {
        if activity.apps.offers("profile", None) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }

    // In its traces, for any console.
    assert!(activity.apps.offers("profile", None));
    assert!(activity.apps.offers("request", Some("billing")));

    // At its own console only: the agent's console, or another app's, can't run them.
    assert!(activity.apps.offers("explain", Some("shop")));
    assert!(activity.apps.offers("users", Some("shop")));
    assert!(!activity.apps.offers("explain", None));
    assert!(!activity.apps.offers("users", Some("billing")));
    // Nor are they asked of it down the connection.
    assert!(!activity.apps.can("explain"));

    drop(stream);
}

#[tokio::test]
async fn a_trace_is_explained_by_its_own_app_never_by_another_one_that_can() {
    let (address, _, activity) = agent().await;
    // A Node BFF runs EXPLAIN down its connection; a Python API only at its own console.
    let (mut bff, _) = hello(
        &address,
        serde_json::json!({"protocol": PROTOCOL, "service": "library-bff", "capabilities": ["explain"]}),
    )
    .await;
    let (_api, _) = hello(
        &address,
        serde_json::json!({"protocol": PROTOCOL, "service": "library-api", "console": ["explain"]}),
    )
    .await;
    for _ in 0..200 {
        if activity.apps.can("explain") && activity.apps.offers("explain", Some("library-api")) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let ask = |service: &'static str| {
        let apps = activity.apps.clone();
        async move {
            apps.ask(
                service,
                "explain",
                serde_json::json!({"explain": {"sql": "EXPLAIN SELECT 1", "params": []}}),
                Duration::from_millis(200),
            )
            .await
        }
    };

    let api = ask("library-api").await;
    let orders = ask("orders").await;

    // The API's trace: not the BFF's to run on its database; the API answers it at its own console.
    assert_eq!(
        api,
        Err("library-api runs EXPLAIN only from its own console: open this trace in the console library-api serves.".to_owned())
    );
    // A service not connected: not the one app that can either.
    assert_eq!(
        orders,
        Err("No app of service orders that can explain is connected.".to_owned())
    );
    // The BFF was asked nothing.
    let mut length = [0u8; 4];
    let read = tokio::time::timeout(Duration::from_millis(100), bff.read_exact(&mut length)).await;
    assert!(read.is_err());
}

#[tokio::test]
async fn a_request_that_names_no_service_goes_to_the_one_app_that_can() {
    let (address, _, activity) = agent().await;
    let (mut stream, _) = hello(
        &address,
        serde_json::json!({"protocol": PROTOCOL, "service": "shop", "capabilities": ["explain"]}),
    )
    .await;
    for _ in 0..200 {
        if activity.apps.can("explain") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let apps = activity.apps.clone();
    let asked = tokio::spawn(async move {
        apps.ask("", "explain", serde_json::json!({}), Duration::from_secs(5))
            .await
    });

    let mut length = [0u8; 4];
    stream.read_exact(&mut length).await.unwrap();
    let mut frame = vec![0u8; u32::from_be_bytes(length) as usize];
    stream.read_exact(&mut frame).await.unwrap();
    let request: serde_json::Value = serde_json::from_slice(&frame).unwrap();
    let reply = serde_json::json!({"answer": request["id"], "rows": []});
    send(&mut stream, reply.to_string().as_bytes()).await;

    assert_eq!(asked.await.unwrap().unwrap()["rows"], serde_json::json!([]));
}
