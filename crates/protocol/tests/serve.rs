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
            thresholds.long_transaction_ms
        ),
        (5, 20, 900)
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
            thresholds.long_transaction_ms
        ),
        (3, 100, 500)
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
