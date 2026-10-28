//! A trace's chain through the console's API: the traces down its calls on its clock, and the records of the whole
//! chain or of what is under one of its rows, added up.

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

fn id(name: &str) -> String {
    format!("01CHA1N{name:0>19}")
}

/// A trace of `app` with these spans and records, called through the W3C span `parent`.
fn trace(
    name: &str,
    app: &str,
    start: i64,
    parent: Option<&str>,
    spans: Value,
    logs: Value,
) -> Received {
    let mut attrs =
        json!({"service.name": app, "w3c.trace_id": "4bf92f3577b34da6a3ce929d0e0e4736"});
    if let Some(parent) = parent {
        attrs["w3c.parent_span_id"] = parent.into();
    }
    let doc = json!({
        "id": id(name), "kind": "http", "name": name, "start": start, "duration": 100, "status": "ok", "attrs": attrs,
        "spans": spans, "logs": logs, "errors": [], "links": [], "issues": [],
    });
    Received {
        trace: serde_json::from_value(doc.clone()).unwrap(),
        doc: doc.to_string(),
    }
}

fn span(
    id: &str,
    parent: Option<&str>,
    name: &str,
    start: i64,
    duration: i64,
    w3c: Option<&str>,
) -> Value {
    let attrs = w3c.map_or(json!({}), |w3c| json!({"w3c.span_id": w3c}));
    json!({"id": id, "parent_id": parent, "kind": "function", "name": name, "start": start, "duration": duration,
           "status": "ok", "attrs": attrs})
}

fn log(span: &str, time: i64, level: &str, message: &str) -> Value {
    json!({"span_id": span, "time": time, "level": level, "logger": "app", "message": message, "exception": null,
           "attrs": {}})
}

#[tokio::test]
async fn a_traces_logs_come_from_its_chain_or_from_under_a_row() {
    let dir = std::env::temp_dir().join(format!("tracepanel-server-chain-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let path = tracepanel_store_local::path_in(&dir);
    // The BFF's step calls the service twice; the service's clock is 1000 µs behind.
    Store::open(&path)
        .unwrap()
        .write(&[
            trace(
                "BFF",
                "library-bff",
                0,
                None,
                json!([
                    span("root", None, "POST /graphql", 0, 100, None),
                    span("step", Some("root"), "Book.author", 10, 80, None),
                    span("call1", Some("step"), "GET /authors/1", 20, 20, Some("c1")),
                    span("call2", Some("step"), "GET /authors/2", 50, 20, Some("c2")),
                ]),
                json!([
                    log("root", 5, "info", "query Books"),
                    log("step", 15, "warning", "slow author")
                ]),
            ),
            trace(
                "API1",
                "library-api",
                -980,
                Some("c1"),
                json!([span("a1", None, "GET", -980, 20, None)]),
                json!([log("a1", -975, "error", "no author 1")]),
            ),
            trace(
                "API2",
                "library-api",
                -950,
                Some("c2"),
                json!([span("a2", None, "GET", -950, 20, None)]),
                json!([log("a2", -945, "info", "author 2")]),
            ),
        ])
        .unwrap();
    let router = tracepanel_server::router(Reader::new(&path), Activity::default());
    let bff = id("BFF");
    let said = |body: &Value| -> Vec<(i64, String, String)> {
        body["logs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|log| {
                (
                    log["time"].as_i64().unwrap(),
                    log["app"].as_str().unwrap().into(),
                    log["message"].as_str().unwrap().into(),
                )
            })
            .collect()
    };
    let row = |time: i64, app: &str, message: &str| (time, app.to_owned(), message.to_owned());

    let (status, chain) = get(&router, &format!("/api/traces/{bff}/chain")).await;
    let (_, whole) = get(&router, &format!("/api/traces/{bff}/logs")).await;
    let (_, alone) = get(&router, &format!("/api/traces/{bff}/logs?scope=trace")).await;
    let (_, under) = get(&router, &format!("/api/traces/{bff}/logs?span=step")).await;
    let (_, only) = get(&router, &format!("/api/traces/{bff}/logs?span=step&only=1")).await;
    let (_, served) = get(
        &router,
        &format!("/api/traces/{bff}/logs?span={}", id("API2")),
    )
    .await;
    let (missing, _) = get(&router, &format!("/api/traces/{}/logs", id("NONE"))).await;

    assert_eq!(status, StatusCode::OK);
    let placed: Vec<Value> = chain["traces"].as_array().unwrap().iter()
        .map(|each| json!({"id": each["id"], "app": each["app"], "parent": each["parent"], "via": each["via"],
                           "shift": each["shift"], "start": each["trace"]["start"]}))
        .collect();
    assert_eq!(
        placed,
        [
            json!({"id": bff, "app": "library-bff", "parent": null, "via": null, "shift": 0, "start": 0}),
            json!({"id": id("API1"), "app": "library-api", "parent": bff, "via": "call1", "shift": 1000, "start": 20}),
            json!({"id": id("API2"), "app": "library-api", "parent": bff, "via": "call2", "shift": 1000, "start": 50}),
        ]
    );
    assert_eq!(chain["capped"], false);

    assert_eq!(
        said(&whole),
        [
            row(5, "library-bff", "query Books"),
            row(15, "library-bff", "slow author"),
            row(25, "library-api", "no author 1"),
            row(55, "library-api", "author 2")
        ]
    );
    assert_eq!(
        json!({"total": whole["summary"]["total"], "levels": whole["summary"]["levels"],
               "apps": whole["summary"]["apps"], "first_error": whole["summary"]["first_error"]["message"]}),
        json!({"total": 4, "levels": {"info": 2, "warning": 1, "error": 1},
               "apps": [{"app": "library-api", "count": 2}, {"app": "library-bff", "count": 2}],
               "first_error": "no author 1"})
    );

    assert_eq!(
        said(&alone),
        [
            row(5, "library-bff", "query Books"),
            row(15, "library-bff", "slow author")
        ]
    );

    assert_eq!(
        said(&under),
        [
            row(15, "library-bff", "slow author"),
            row(25, "library-api", "no author 1"),
            row(55, "library-api", "author 2")
        ]
    );
    assert_eq!(under["window"], json!({"start": 10, "end": 90}));

    assert_eq!(said(&only), [row(15, "library-bff", "slow author")]);

    assert_eq!(said(&served), [row(55, "library-api", "author 2")]);

    assert_eq!(missing, StatusCode::NOT_FOUND);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_chains_queries_and_issues_come_from_its_calls_and_one_n_plus_one_across_apps() {
    let dir = std::env::temp_dir().join(format!(
        "tracepanel-server-chain-calls-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    let path = tracepanel_store_local::path_in(&dir);
    let step = |n: i64| {
        let mut step = span(
            &format!("step{n}"),
            Some("root"),
            "Book.author",
            10 + n * 20,
            15,
            None,
        );
        step["attrs"]["graphql.field"] = json!("Book.author");
        step
    };
    let call = |n: i64| {
        let mut call = span(
            &format!("call{n}"),
            Some(&format!("step{n}")),
            "GET /authors/{id}",
            12 + n * 20,
            10,
            Some(&format!("c00000000000000{n}")),
        );
        call["kind"] = json!("http.client");
        call["attrs"]["http.method"] = json!("GET");
        call["attrs"]["url.full"] = json!(format!("http://api/authors/{n}"));
        call
    };
    let mut bff_spans = vec![span("root", None, "POST /graphql", 0, 100, None)];
    for n in 0..3 {
        bff_spans.push(step(n));
        bff_spans.push(call(n));
    }
    let mut traces = vec![trace(
        "BFF",
        "library-bff",
        0,
        None,
        Value::Array(bff_spans),
        json!([]),
    )];
    for n in 0..3 {
        let at = 12 + n * 20;
        let mut sql = span(
            &format!("q{n}"),
            Some(&format!("a{n}")),
            "SELECT author",
            at + 2,
            3,
            None,
        );
        sql["kind"] = json!("sql");
        let mut api = trace(
            &format!("API{n}"),
            "library-api",
            at,
            Some(&format!("c00000000000000{n}")),
            json!([
                span(&format!("a{n}"), None, "GET /authors/{id}", at, 8, None),
                sql
            ]),
            json!([]),
        );
        let mut doc: Value = serde_json::from_str(&api.doc).unwrap();
        doc["attrs"]["http.route"] = json!("/authors/{id}");
        doc["duration"] = json!(8);
        api = Received {
            trace: serde_json::from_value(doc.clone()).unwrap(),
            doc: doc.to_string(),
        };
        traces.push(api);
    }
    Store::open(&path).unwrap().write(&traces).unwrap();
    let router = tracepanel_server::router(Reader::new(&path), Activity::default());
    let bff = id("BFF");

    let (status, sql) = get(&router, &format!("/api/traces/{bff}/calls?system=sql")).await;
    let (_, http) = get(
        &router,
        &format!("/api/traces/{bff}/calls?system=http&span=step1"),
    )
    .await;
    let (_, issues) = get(&router, &format!("/api/traces/{bff}/issues")).await;
    let (_, served) = get(
        &router,
        &format!("/api/traces/{bff}/issues?span={}", id("API1")),
    )
    .await;
    let (_, chain) = get(&router, &format!("/api/traces/{bff}/chain")).await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        json!({"count": sql["summary"]["count"], "wall": sql["summary"]["wall"], "groups": sql["summary"]["groups"].as_array().unwrap().len(),
               "traces": sql["summary"]["groups"][0]["traces"], "apps": sql["summary"]["apps"]}),
        json!({"count": 3, "wall": 9, "groups": 1, "traces": 3, "apps": [{"app": "library-api", "count": 3}]})
    );

    assert_eq!(
        http["calls"]
            .as_array()
            .unwrap()
            .iter()
            .map(|call| call["id"].clone())
            .collect::<Vec<_>>(),
        [json!("call1")]
    );

    let found: Vec<Value> = issues["issues"].as_array().unwrap().iter()
        .map(|issue| json!({"kind": issue["kind"], "app": issue["app"], "chain": issue["chain"], "span_ids": issue["span_ids"]}))
        .collect();
    assert!(found.contains(&json!({"kind": "n+1", "app": "library-bff", "chain": true, "span_ids": ["call0", "call1", "call2"]})), "{found:?}");

    assert_eq!(served["issues"], json!([]));

    assert_eq!(chain["issues"].as_array().unwrap().len(), 1);
    assert_eq!(chain["issues"][0]["trace_id"], json!(bff));
    let _ = std::fs::remove_dir_all(&dir);
}
