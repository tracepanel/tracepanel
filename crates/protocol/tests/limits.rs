//! A trace over the agent's limits, whatever sent it: cut to its earliest spans (every one kept with its parent, its
//! root always) and first records, with how many went in its attrs.

use serde_json::{Value, json};
use tracepanel_protocol::{Batch, MAX_LOGS, MAX_SPANS, Thresholds};

fn batch(trace: &Value) -> Batch {
    Batch {
        frame: serde_json::to_vec(&json!([trace])).unwrap(),
        max_traces: None,
        thresholds: Thresholds::default(),
    }
}

#[test]
fn a_runaway_trace_is_cut_to_the_limits_its_tree_whole() {
    // The root last, as an SDK appends spans when they end; each span the child of the one before.
    let mut spans: Vec<Value> = (1..=MAX_SPANS + 500)
        .map(|n| {
            json!({"id": format!("s{n}"), "parent_id": if n == 1 { "root".to_owned() } else { format!("s{}", n - 1) },
                   "kind": "function", "name": "step", "start": n, "duration": 1, "status": "ok", "attrs": {}})
        })
        .collect();
    spans.push(
        json!({"id": "root", "parent_id": null, "kind": "http", "name": "GET /", "start": 0,
                      "duration": 10_000, "status": "ok", "attrs": {}}),
    );
    let logs: Vec<Value> = (0..MAX_LOGS + 1500)
        .map(|n| json!({"span_id": null, "time": n, "level": "info", "logger": "shop", "message": format!("line {n}"),
                        "exception": null, "attrs": {}}))
        .collect();
    let trace = json!({"id": "T", "kind": "http", "name": "GET /", "start": 0, "duration": 10_000, "status": "ok",
                       "attrs": {"tracepanel.dropped_logs": 3}, "spans": spans, "logs": logs});

    let [received] = <[_; 1]>::try_from(batch(&trace).decode().unwrap())
        .ok()
        .unwrap();
    let doc: Value = serde_json::from_str(&received.doc).unwrap();
    let ids: Vec<&str> = received
        .trace
        .spans
        .iter()
        .map(|span| span.id.as_str())
        .collect();
    let kept: std::collections::HashSet<&str> = ids.iter().copied().collect();

    assert_eq!(received.trace.spans.len(), MAX_SPANS);
    assert!(kept.contains("root"));
    assert!(received.trace.spans.iter().all(|span| {
        span.parent_id
            .as_deref()
            .is_none_or(|parent| kept.contains(parent))
    }));
    assert_eq!(received.trace.logs.len(), MAX_LOGS);
    assert_eq!(
        received.trace.logs.last().map(|log| log.message.as_str()),
        Some("line 999")
    );

    // Counted where the SDK counts its own drops, added to them.
    assert_eq!(doc["attrs"]["tracepanel.dropped_spans"], 501);
    assert_eq!(doc["attrs"]["tracepanel.dropped_logs"], 1503);
    assert_eq!(received.trace.attrs["tracepanel.dropped_spans"], 501);
}

#[test]
fn a_trace_within_the_limits_is_kept_as_sent() {
    let trace = json!({"id": "T", "kind": "http", "name": "GET /", "start": 0, "duration": 1, "status": "ok",
                       "attrs": {}, "spans": [], "logs": []});
    let sent = serde_json::to_string(&trace).unwrap();

    let received = batch(&trace).decode().unwrap();

    assert_eq!(received[0].doc, sent);
}
