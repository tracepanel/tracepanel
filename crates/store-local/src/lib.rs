//! Local SQLite storage: a project's traces, logs, queries, emails and issues, and the console's reads of them. Some
//! conventions come from the store's Python origins and show in the API: "falsy" values fall back to defaults,
//! attribute values are compared as Python's `str()` writes them, booleans are 0/1.

use rusqlite::types::Value as Sql;
use rusqlite::{Connection, params};
use serde_json::Value;
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use tracepanel_protocol::{Attrs, Received, Span, Trace};

pub mod search;
use search::{Compiler, SearchError, Term};

mod groups;
mod read;
mod searches;
mod services;
mod stats;
mod values;
mod write;

use read::*;
use searches::*;
use services::*;
use stats::*;
use values::*;
use write::*;

pub use read::{Page, ReadError, Reader};
/// The store's errors (SQLite's).
pub use rusqlite::Error;
pub use stats::{SLOW_REQUEST_US, stats};
pub use tracepanel_analysis::calls::{call_key, query_fingerprint};
pub use write::{DEFAULT_MAX_TRACES, SCHEMA, Store, path_in, version};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_from_the_schema() {
        assert!(version().chars().all(|char| char.is_ascii_digit()));
    }

    #[test]
    fn python_views() {
        assert!(!truthy(Some(&Value::from(0))));
        assert!(!truthy(Some(&Value::from(""))));
        assert!(truthy(Some(&Value::from("x"))));
        assert_eq!(py_str(&Value::from(true)), "True");
        assert_eq!(py_str(&serde_json::json!(1.0)), "1.0");
    }

    /// A request that reads three users through Django's cache (on Redis), a Redis GET under each, and one direct
    /// INCR that fails.
    fn cached_request() -> Received {
        let mut spans = vec![serde_json::json!({
            "id": "root", "parent_id": null, "kind": "http", "name": "GET /", "start": 0, "duration": 100,
            "status": "ok", "attrs": {},
        })];
        for n in 1..=3 {
            spans.push(serde_json::json!({
                "id": format!("c{n}"), "parent_id": "root", "kind": "cache", "name": "cache.get", "start": n,
                "duration": 3, "status": "ok", "attrs": {
                    "cache.alias": "default", "cache.system": "redis", "cache.op": "get", "cache.key": format!("user:{n}"),
                    "cache.hit": n == 1, "code.origin": "app/views.py:10 in feed",
                },
            }));
            spans.push(serde_json::json!({
                "id": format!("r{n}"), "parent_id": format!("c{n}"), "kind": "redis", "name": format!("GET :1:user:{n}"),
                "start": n, "duration": 2, "status": "ok", "attrs": {
                    "db.system": "redis", "db.operation": "GET", "redis.alias": "redis", "redis.key": format!(":1:user:{n}"),
                    "code.origin": "app/views.py:10 in feed",
                },
            }));
        }
        spans.push(serde_json::json!({
            "id": "incr", "parent_id": "root", "kind": "redis", "name": "INCR hits", "start": 9, "duration": 1,
            "status": "error", "attrs": {
                "db.system": "redis", "db.operation": "INCR", "redis.alias": "redis", "redis.key": "hits",
                "code.origin": "app/views.py:12 in feed",
            },
        }));
        let doc = serde_json::json!({
            "id": "t1", "kind": "http", "name": "GET /", "start": 0, "duration": 100, "status": "ok",
            "attrs": {"service.name": "shop"}, "spans": spans, "logs": [], "errors": [], "links": [], "issues": [],
        });
        Received {
            trace: serde_json::from_value(doc.clone()).unwrap(),
            doc: doc.to_string(),
        }
    }

    /// `cached_request` as the trace `id`, started at `start`.
    fn request_as(id: &str, start: i64) -> Received {
        let mut doc: Value = serde_json::from_str(&cached_request().doc).unwrap();
        doc["id"] = id.into();
        doc["start"] = start.into();
        Received {
            trace: serde_json::from_value(doc.clone()).unwrap(),
            doc: doc.to_string(),
        }
    }

    #[test]
    fn rpc_calls_served_are_listed_by_method() {
        let dir = std::env::temp_dir().join(format!("tracepanel-store-rpc-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = path_in(&dir);
        let mut store = Store::open(&path).unwrap();
        let call = |id: &str, method: &str, status: &str| {
            let doc = serde_json::json!({
                "id": id, "kind": "rpc", "name": format!("helloworld.Greeter/{method}"), "start": 0, "duration": 2000,
                "status": status, "attrs": {"service.name": "greeter", "rpc.system": "grpc"},
                "spans": [], "logs": [], "errors": [], "links": [], "issues": [],
            });
            Received {
                trace: serde_json::from_value(doc.clone()).unwrap(),
                doc: doc.to_string(),
            }
        };
        store
            .write(&[
                call("R1", "SayHello", "ok"),
                call("R2", "SayHello", "error"),
                call("R3", "SayBye", "ok"),
            ])
            .unwrap();
        let reader = Reader::new(&path);

        let rows = reader.list_rpcs("", 50).unwrap();
        let listed: Vec<(Value, Value, Value, Value)> = rows
            .iter()
            .map(|row| {
                (
                    row["rpc"].clone(),
                    row["system"].clone(),
                    row["calls"].clone(),
                    row["failures"].clone(),
                )
            })
            .collect();
        assert_eq!(
            listed,
            [
                (
                    "helloworld.Greeter/SayHello".into(),
                    "grpc".into(),
                    2.into(),
                    1.into()
                ),
                (
                    "helloworld.Greeter/SayBye".into(),
                    "grpc".into(),
                    1.into(),
                    0.into()
                ),
            ]
        );
        assert_eq!(reader.list_rpcs("rpc:*Bye", 50).unwrap().len(), 1);
        assert_eq!(reader.counts(None).unwrap()["sections"]["rpc"], 3);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rotation_keeps_the_newest_traces_and_only_their_rows() {
        let dir =
            std::env::temp_dir().join(format!("tracepanel-store-prune-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = path_in(&dir);
        let mut store = Store::open(&path).unwrap();
        store.max_traces = 10;
        for n in 0..30 {
            store.write(&[request_as(&format!("t{n:02}"), n)]).unwrap();
        }
        // Sent again: its first copy's rows go.
        store.write(&[request_as("t29", 29)]).unwrap();
        let db = rusqlite::Connection::open(&path).unwrap();
        let ids = |sql: &str| -> Vec<String> {
            let mut statement = db.prepare(sql).unwrap();
            statement
                .query_map([], |row| row.get(0))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap()
        };

        let kept: Vec<String> = (20..30).map(|n| format!("t{n}")).collect();
        assert_eq!(ids("SELECT id FROM traces ORDER BY id"), kept);
        for table in ["calls", "peers"] {
            assert_eq!(
                ids(&format!(
                    "SELECT DISTINCT trace_id FROM {table} ORDER BY trace_id"
                )),
                kept,
                "{table}"
            );
        }
        // Seven calls a trace (three cache gets, three Redis GETs, an INCR), the one sent twice included.
        assert_eq!(ids("SELECT COUNT(*) || '' FROM calls"), ["70"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rotation_keeps_the_issues_whole_and_drops_links_to_traces_gone() {
        let dir = std::env::temp_dir().join(format!(
            "tracepanel-store-prune-issues-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let path = path_in(&dir);
        let mut store = Store::open(&path).unwrap();
        store.max_traces = 2;
        let issue = |fingerprint: &str| {
            serde_json::json!({"fingerprint": fingerprint, "fingerprint_version": 1, "kind": "error",
                               "title": fingerprint, "culprit": null, "hint": null})
        };
        let trace = |id: &str, start: i64, fingerprint: &str, sent_by: Option<&str>| {
            let links: Vec<Value> = sent_by
                .map(|sender| serde_json::json!({"kind": "sent_by", "trace_id": sender, "span_id": "S"}))
                .into_iter()
                .collect();
            let doc = serde_json::json!({
                "id": id, "kind": "task", "name": "BookEvents.onAnnounced", "start": start, "duration": 1,
                "status": "error", "attrs": {"service.name": "shop"}, "spans": [], "logs": [], "errors": [],
                "links": links, "issues": [issue(fingerprint)],
            });
            Received {
                trace: serde_json::from_value(doc.clone()).unwrap(),
                doc: doc.to_string(),
            }
        };
        // Each write rotates (a limit of 2): t0 and t1 go.
        for received in [
            trace("t0", 0, "G", None),
            trace("t1", 1, "F", None),
            trace("t2", 2, "F", Some("t0")),
            trace("t3", 3, "F", None),
        ] {
            store.write(&[received]).unwrap();
        }
        let db = rusqlite::Connection::open(&path).unwrap();
        let issues: Vec<(String, i64, i64, i64, String)> = db
            .prepare(
                "SELECT fingerprint, occurrences, first_seen, last_seen, last_trace_id FROM issues",
            )
            .unwrap()
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        let links: i64 = db
            .query_row("SELECT count(*) FROM links", [], |row| row.get(0))
            .unwrap();

        // Every time it happened, rotated out or not: G keeps its one occurrence with no trace left, F its three.
        assert_eq!(
            issues,
            [
                ("G".to_owned(), 1, 0, 0, "t0".to_owned()),
                ("F".to_owned(), 3, 1, 3, "t3".to_owned())
            ]
        );
        assert_eq!(links, 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_trace_is_found_by_any_of_its_spans_by_name() {
        let dir = std::env::temp_dir().join(format!(
            "tracepanel-store-span-search-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let path = path_in(&dir);
        let mut store = Store::open(&path).unwrap();
        let trace = |id: &str, block: &str| {
            let doc = serde_json::json!({
                "id": id, "kind": "http", "name": "GET /report", "start": 0, "duration": 10, "status": "ok",
                "attrs": {"service.name": "shop"}, "logs": [], "errors": [], "links": [], "issues": [],
                "spans": [
                    {"id": "R", "parent_id": null, "kind": "http", "name": "GET /report", "start": 0, "duration": 10,
                     "status": "ok", "attrs": {}},
                    {"id": "B", "parent_id": "R", "kind": "function", "name": block, "start": 1, "duration": 5,
                     "status": "ok", "attrs": {}},
                ],
            });
            Received {
                trace: serde_json::from_value(doc.clone()).unwrap(),
                doc: doc.to_string(),
            }
        };
        store
            .write(&[
                trace("A", "reports.build_pdf"),
                trace("B", "reports.send_mail"),
                request_as("C", 9),
            ])
            .unwrap();
        let reader = Reader::new(&path);
        let ids = |query: &str| -> Vec<String> {
            let mut found: Vec<String> = reader
                .search_traces(query, 50, None)
                .unwrap()
                .items
                .iter()
                .map(|trace| trace["id"].as_str().unwrap().to_owned())
                .collect();
            found.sort();
            found
        };

        assert_eq!(ids("span:reports.build_pdf"), ["A"]);
        assert_eq!(ids("span:reports.*"), ["A", "B"]);
        assert_eq!(ids("span!=reports.build_pdf"), ["B", "C"]);
        // A call by its name too, from calls: the spans table holds the other spans alone.
        assert_eq!(ids("span:INCR*"), ["C"]);
        let rows: i64 = rusqlite::Connection::open(&path)
            .unwrap()
            .query_row(
                "SELECT count(*) FROM spans WHERE trace_id = 'C'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(rows, 0);
        // The root is the trace itself, found by its name already.
        assert_eq!(ids("span:GET /report"), Vec::<String>::new());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_stored_trace_says_when_the_agent_received_it() {
        let dir =
            std::env::temp_dir().join(format!("tracepanel-store-received-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = path_in(&dir);
        let mut store = Store::open(&path).unwrap();
        let before = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_micros() as i64;

        store.write(&[request_as("r1", 5)]).unwrap();
        let doc: Value =
            serde_json::from_str(&Reader::new(&path).get_trace("r1").unwrap().unwrap()).unwrap();

        // By the agent's clock, the app's own times left as sent.
        assert!(doc["received"].as_i64().unwrap() >= before);
        assert_eq!(doc["start"], 5);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn every_table_with_rows_per_trace_is_cleared_with_its_trace() {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch(SCHEMA).unwrap();
        let tables: Vec<String> = db
            .prepare(
                "SELECT m.name FROM sqlite_master m, pragma_table_info(m.name) c
                 WHERE m.type = 'table' AND c.name = 'trace_id' ORDER BY m.name",
            )
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        let mut cleared: Vec<String> = write::PER_TRACE
            .iter()
            .map(|table| (*table).to_owned())
            .collect();
        cleared.sort();

        // A table missing here keeps its rows after rotation removes their trace.
        assert_eq!(tables, cleared);
    }

    /// A trace of `service` with W3C ids: called through `parent` (another trace's span), calling out through `out`.
    fn w3c_trace(
        id: &str,
        service: &str,
        start: i64,
        parent: Option<&str>,
        out: Option<&str>,
    ) -> Received {
        let mut attrs = serde_json::json!({
            "service.name": service, "service.role": "web", "w3c.trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
        });
        if let Some(parent) = parent {
            attrs["w3c.parent_span_id"] = parent.into();
        }
        let spans: Vec<Value> = out
            .map(|out| {
                serde_json::json!({
                    "id": format!("{id}-call"), "parent_id": null, "kind": "http.client", "name": "POST billing/charge",
                    "start": start + 1, "duration": 5, "status": "ok", "attrs": {
                        "http.method": "POST", "server.address": "billing", "server.port": 8000,
                        "url.full": "http://billing:8000/charge", "w3c.span_id": out,
                    },
                })
            })
            .into_iter()
            .collect();
        let doc = serde_json::json!({
            "id": id, "kind": "http", "name": "POST /charge", "start": start, "duration": 10,
            "status": if out.is_some() { "ok" } else { "error" }, "attrs": attrs, "spans": spans,
            "logs": [], "errors": [], "links": [], "issues": [],
        });
        Received {
            trace: serde_json::from_value(doc.clone()).unwrap(),
            doc: doc.to_string(),
        }
    }

    #[test]
    fn a_snapshot_holds_the_trace_and_what_it_called_without_what_stays_local() {
        let dir =
            std::env::temp_dir().join(format!("tracepanel-store-snapshot-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = path_in(&dir);
        let mut store = Store::open(&path).unwrap();
        let mut shop: Value =
            serde_json::from_str(&w3c_trace("SHOP", "shop", 0, None, Some("00f067aa0ba902b7")).doc)
                .unwrap();
        shop["attrs"]["user.email"] = "ann@example.com".into();
        shop["spans"][0]["attrs"]["db.params"] = serde_json::json!([42]);
        let shop = Received {
            trace: serde_json::from_value(shop.clone()).unwrap(),
            doc: shop.to_string(),
        };
        store
            .write(&[
                shop,
                w3c_trace("BILLING", "billing", 2, Some("00f067aa0ba902b7"), None),
            ])
            .unwrap();
        let reader = Reader::new(&path);

        let shared = reader.snapshot("SHOP", false).unwrap().unwrap();
        let with_values = reader.snapshot("SHOP", true).unwrap().unwrap();

        assert_eq!(
            (&shared["root"], &shared["values"], &shared["format"]),
            (&Value::from("SHOP"), &Value::from(false), &Value::from(1))
        );
        let ids = |map: &Value| map.as_object().unwrap().keys().cloned().collect::<Vec<_>>();
        assert_eq!(ids(&shared["traces"]), ["BILLING", "SHOP"]);
        assert_eq!(ids(&shared["related"]), ["BILLING", "SHOP"]);
        assert_eq!(shared["related"]["BILLING"]["called_by"]["id"], "SHOP");

        assert_eq!(shared["traces"]["SHOP"]["attrs"].get("user.email"), None);
        assert_eq!(
            shared["traces"]["SHOP"]["spans"][0]["attrs"].get("db.params"),
            None
        );
        assert_eq!(
            with_values["traces"]["SHOP"]["attrs"]["user.email"],
            "ann@example.com"
        );
        assert_eq!(
            with_values["traces"]["SHOP"]["spans"][0]["attrs"]["db.params"],
            serde_json::json!([42])
        );

        assert_eq!(reader.snapshot("NONE", false).unwrap(), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_call_links_the_trace_it_reached_whichever_comes_first() {
        let dir = std::env::temp_dir().join(format!("tracepanel-store-w3c-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = path_in(&dir);
        let mut store = Store::open(&path).unwrap();
        let shop = || w3c_trace("SHOP", "shop", 0, None, Some("00f067aa0ba902b7"));
        let billing = || w3c_trace("BILLING", "billing", 2, Some("00f067aa0ba902b7"), None);
        // The called app's trace first (it ends first), then the caller's, then the callee's again (late spans).
        store.write(&[billing()]).unwrap();
        store.write(&[shop()]).unwrap();
        store.write(&[billing()]).unwrap();
        let reader = Reader::new(&path);

        let to_billing = reader.related("BILLING").unwrap();
        assert_eq!(to_billing["called_by"]["id"], "SHOP");
        let from_shop = reader.related("SHOP").unwrap();
        assert_eq!(
            (
                from_shop["calls"].as_array().unwrap().len(),
                &from_shop["calls"][0]["id"],
                &from_shop["via"]["BILLING"]
            ),
            (1, &Value::from("BILLING"), &Value::from("SHOP-call"))
        );

        let services = reader.list_services("").unwrap();
        assert_eq!(
            services["links"],
            serde_json::json!([{"service": "shop", "role": "web", "to_service": "billing", "to_role": "web",
                                "peer": "http:http/billing:8000", "traces": 1, "total": 10, "errors": 1}])
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_upgraded_app_is_one_app_labelled_as_it_runs_now() {
        let dir =
            std::env::temp_dir().join(format!("tracepanel-store-upgrade-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = path_in(&dir);
        let mut store = Store::open(&path).unwrap();
        let run = |id: &str, start: i64, java: &str, spring: &str| {
            let doc = serde_json::json!({
                "id": id, "kind": "http", "name": "GET /", "start": start, "duration": 10, "status": "ok",
                "attrs": {"service.name": "shop", "service.role": "web", "telemetry.sdk.language": "java",
                          "process.runtime.version": java, "tracepanel.framework": spring},
                "spans": [], "logs": [], "errors": [], "links": [], "issues": [],
            });
            Received {
                trace: serde_json::from_value(doc.clone()).unwrap(),
                doc: doc.to_string(),
            }
        };
        // Before the upgrade, then after it: the largest strings would be Java 8.0 and Spring Boot 4.9.
        store
            .write(&[run("OLD", 1_000, "8.0.2", "Spring Boot 4.9.2")])
            .unwrap();
        store
            .write(&[run("NEW", 2_000, "21.0.9", "Spring Boot 4.10.0")])
            .unwrap();
        let services = Reader::new(&path).list_services("").unwrap();

        assert_eq!(
            services["apps"]
                .as_array()
                .unwrap()
                .iter()
                .map(|app| (
                    app["service"].clone(),
                    app["traces"].clone(),
                    app["runtime"].clone()
                ))
                .collect::<Vec<_>>(),
            [(
                Value::from("shop"),
                Value::from(2),
                Value::from("Java 21 · Spring Boot 4.10")
            )]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_trace_received_twice_counts_once() {
        let dir =
            std::env::temp_dir().join(format!("tracepanel-store-twice-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = path_in(&dir);
        let mut store = Store::open(&path).unwrap();
        store.write(&[cached_request()]).unwrap();
        // The same trace again, as an SDK sends it when spans came late.
        store.write(&[cached_request()]).unwrap();
        let reader = Reader::new(&path);
        let calls = |rows: Vec<Value>| {
            rows.iter()
                .map(|row| row["calls"].clone())
                .collect::<Vec<_>>()
        };

        assert_eq!(
            calls(reader.list_calls("system:redis", 50).unwrap()),
            [Value::from(3), Value::from(1)]
        );
        assert_eq!(
            calls(reader.list_calls("system:cache", 50).unwrap()),
            [Value::from(3)]
        );
        let services = reader.list_services("").unwrap();
        assert_eq!(
            services["services"]
                .as_array()
                .unwrap()
                .iter()
                .map(|node| (node["kind"].clone(), node["calls"].clone()))
                .collect::<Vec<_>>(),
            // The cache on Redis (3 gets) and Redis itself (3 GETs and an INCR), each once.
            [
                (Value::from("cache"), Value::from(3)),
                (Value::from("database"), Value::from(4))
            ]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_systems_calls_at_a_glance() {
        let dir =
            std::env::temp_dir().join(format!("tracepanel-store-summary-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = path_in(&dir);
        Store::open(&path)
            .unwrap()
            .write(&[cached_request()])
            .unwrap();
        let reader = Reader::new(&path);

        assert_eq!(
            reader.calls_summary("system:redis").unwrap(),
            serde_json::json!({"calls": 4, "traces": 1, "most_per_trace": 4, "errors": 1, "total": 7, "p95": 2,
                               "hits": null, "misses": null})
        );

        // A cache's hits and misses; the same filters as its list.
        assert_eq!(
            reader.calls_summary("system:cache").unwrap(),
            serde_json::json!({"calls": 3, "traces": 1, "most_per_trace": 3, "errors": 0, "total": 9, "p95": 3,
                               "hits": 1, "misses": 2})
        );
        assert_eq!(
            reader.calls_summary("system:redis failed:true").unwrap()["calls"],
            1
        );

        // No calls: zeros, and nothing to rank.
        assert_eq!(
            reader.calls_summary("system:mongodb").unwrap(),
            serde_json::json!({"calls": 0, "traces": 0, "most_per_trace": null, "errors": 0, "total": 0,
                               "p95": null, "hits": null, "misses": null})
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cache_and_redis_calls_take_the_same_filters() {
        let dir =
            std::env::temp_dir().join(format!("tracepanel-store-cache-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = path_in(&dir);
        Store::open(&path)
            .unwrap()
            .write(&[cached_request()])
            .unwrap();
        let reader = Reader::new(&path);
        let fields = |rows: Vec<Value>, names: &[&str]| -> Vec<Vec<Value>> {
            rows.into_iter()
                .map(|row| names.iter().map(|name| row[*name].clone()).collect())
                .collect()
        };

        assert_eq!(
            fields(
                reader
                    .list_calls("system:cache db:default op:GET", 50)
                    .unwrap(),
                &[
                    "op",
                    "template",
                    "vendor",
                    "calls",
                    "hits",
                    "misses",
                    "most_per_trace",
                    "errors"
                ]
            ),
            [
                serde_json::json!(["get", "user:{id}", "redis", 3, 1, 2, 3, 0])
                    .as_array()
                    .unwrap()
                    .clone()
            ]
        );

        assert_eq!(
            fields(
                reader.list_calls("system:redis", 50).unwrap(),
                &["op", "template", "via", "calls", "errors"]
            ),
            [
                serde_json::json!(["GET", ":{id}:user:{id}", "cache", 3, 0])
                    .as_array()
                    .unwrap()
                    .clone(),
                serde_json::json!(["INCR", "hits", "direct", 1, 1])
                    .as_array()
                    .unwrap()
                    .clone(),
            ]
        );
        assert_eq!(
            fields(
                reader
                    .list_calls("system:redis failed:true via:direct op:incr", 50)
                    .unwrap(),
                &["op"]
            ),
            [vec![Value::from("INCR")]]
        );
        assert!(
            reader
                .list_calls("system:redis via:task", 50)
                .unwrap()
                .is_empty()
        );
        assert!(
            reader
                .list_calls("system:cache failed:true", 50)
                .unwrap()
                .is_empty()
        );

        let known = reader.known_values("").unwrap();
        let counts = reader.counts(None).unwrap();
        assert_eq!(
            counts["sections"],
            serde_json::json!({"http": 1, "graphql": 0, "tasks": 0, "websockets": 0, "jobs": 0, "rpc": 0, "pages": 0,
                               "mails": 0,
                               "systems": [{"system": "redis", "family": "redis", "label": "Redis"},
                                           {"system": "cache", "family": "cache", "label": "Cache"}]})
        );
        assert_eq!(
            known["targets"],
            serde_json::json!({"cache": ["default"], "redis": ["redis"]})
        );
        assert_eq!(
            known["ops"],
            serde_json::json!({"cache": ["get"], "redis": ["GET", "INCR"]})
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn records_are_counted_over_time_by_level() {
        let dir = std::env::temp_dir().join(format!(
            "tracepanel-store-log-series-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let path = path_in(&dir);
        let mut store = Store::open(&path).unwrap();
        let minute = 60_000_000_i64;
        let log = |time: i64, level: &str| {
            serde_json::json!({"span_id": null, "time": time, "level": level, "logger": "shop", "message": "m",
                               "exception": null, "attrs": {}})
        };
        let doc = serde_json::json!({
            "id": "S1", "kind": "http", "name": "GET /", "start": 0, "duration": 1000, "status": "ok",
            "attrs": {"service.name": "shop"}, "errors": [], "links": [], "issues": [],
            "spans": [{"id": "R", "parent_id": null, "kind": "http", "name": "GET /", "start": 0, "duration": 10,
                       "status": "ok", "attrs": {}}],
            "logs": [log(0, "info"), log(1, "error"), log(30 * minute, "info"), log(59 * minute, "warning")],
        });
        store
            .write(&[Received {
                trace: serde_json::from_value(doc.clone()).unwrap(),
                doc: doc.to_string(),
            }])
            .unwrap();
        let reader = Reader::new(&path);
        let series = reader.log_series("", 60).unwrap()["series"]
            .as_array()
            .unwrap()
            .clone();
        let total: i64 = series
            .iter()
            .map(|bucket| bucket["count"].as_i64().unwrap())
            .sum();

        assert_eq!(series.len(), 60);
        assert_eq!(total, 4);
        assert_eq!(
            series[0]["levels"],
            serde_json::json!({"info": 1, "error": 1})
        );
        assert_eq!(series[59]["levels"], serde_json::json!({"warning": 1}));
        // A search counts only what it finds.
        let errors = reader.log_series("level:error", 60).unwrap();
        let counted: i64 = errors["series"]
            .as_array()
            .unwrap()
            .iter()
            .map(|b| b["count"].as_i64().unwrap())
            .sum();
        assert_eq!(counted, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_record_is_found_by_the_spans_it_was_logged_in() {
        let dir = std::env::temp_dir().join(format!(
            "tracepanel-store-log-context-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let path = path_in(&dir);
        let mut store = Store::open(&path).unwrap();
        let span = |id: &str, parent: Option<&str>, kind: &str, name: &str, attrs: Value| {
            serde_json::json!({"id": id, "parent_id": parent, "kind": kind, "name": name, "start": 0, "duration": 10,
                               "status": "ok", "attrs": attrs})
        };
        let log = |span_id: Option<&str>, message: &str| {
            serde_json::json!({"span_id": span_id, "time": 10, "level": "info", "logger": "shop", "message": message,
                               "exception": null, "attrs": {}})
        };
        let mut order = log(Some("V"), "order for Book 5");
        order["attrs"] = serde_json::json!({"log.template": "order for {}"});
        let doc = serde_json::json!({
            "id": "C1", "kind": "http", "name": "POST /api/orders", "start": 0, "duration": 1000, "status": "ok",
            "attrs": {"service.name": "shop", "http.route": "/api/orders"}, "errors": [], "links": [], "issues": [],
            "spans": [
                span("R", None, "http", "POST /api/orders", serde_json::json!({})),
                span("V", Some("R"), "view", "shop.ShopController.order", serde_json::json!({})),
                span("K", Some("V"), "kafka", "publish orders",
                     serde_json::json!({"messaging.system": "kafka", "messaging.destination.name": "orders"})),
            ],
            "logs": [
                log(Some("K"), "initializing Kafka metrics"),
                order,
                log(Some("R"), "request in"),
                log(None, "outside"),
            ],
        });
        store
            .write(&[Received {
                trace: serde_json::from_value(doc.clone()).unwrap(),
                doc: doc.to_string(),
            }])
            .unwrap();
        let reader = Reader::new(&path);
        let messages = |query: &str| -> Vec<Value> {
            reader
                .search_logs(query, 50, None)
                .unwrap()
                .items
                .iter()
                .map(|log| log["message"].clone())
                .collect()
        };
        let kafka = reader.search_logs("in:kafka", 50, None).unwrap().items;

        assert_eq!(
            messages("in:kafka"),
            [Value::from("initializing Kafka metrics")]
        );
        // Logged in that span itself, by its id.
        assert_eq!(
            messages("span_id:K"),
            [Value::from("initializing Kafka metrics")]
        );
        assert_eq!(
            messages("span:shop.ShopController.*"),
            [
                Value::from("order for Book 5"),
                Value::from("initializing Kafka metrics")
            ]
        );
        assert_eq!(
            messages("in!=kafka"),
            [
                Value::from("outside"),
                Value::from("request in"),
                Value::from("order for Book 5")
            ]
        );

        assert_eq!(
            messages("template:\"order for {}\""),
            [Value::from("order for Book 5")]
        );

        assert_eq!(kafka[0]["span_id"], "K");
        assert_eq!(
            kafka[0]["spans"],
            serde_json::json!([
                {"kind": "kafka", "system": "kafka", "name": "publish orders"},
                {"kind": "view", "system": "view", "name": "shop.ShopController.order"},
            ])
        );

        let known = reader.known_values("").unwrap();
        assert_eq!(known["log_route"], serde_json::json!(["/api/orders"]));
        assert_eq!(known["in"], serde_json::json!(["kafka", "view"]));
        // Calls have their own keys: the hints name the other spans.
        assert_eq!(
            known["span"],
            serde_json::json!(["shop.ShopController.order"])
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_tasks_or_a_jobs_records_are_found_by_its_name() {
        let dir = std::env::temp_dir().join(format!(
            "tracepanel-store-log-sources-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let path = path_in(&dir);
        let mut store = Store::open(&path).unwrap();
        let logged = |id: &str, kind: &str, name: &str, message: &str| {
            let doc = serde_json::json!({
                "id": id, "kind": kind, "name": name, "start": 0, "duration": 1000, "status": "ok",
                "attrs": {"service.name": "shop", "task.system": (kind == "task").then_some("rabbitmq")},
                "spans": [], "errors": [], "links": [], "issues": [],
                "logs": [{"span_id": null, "time": 10, "level": "info", "logger": "shop", "message": message,
                          "exception": null, "attrs": {}}],
            });
            Received {
                trace: serde_json::from_value(doc.clone()).unwrap(),
                doc: doc.to_string(),
            }
        };
        store
            .write(&[
                logged("L1", "task", "Orders.onOrder", "order for Book 5"),
                logged("L2", "command", "Notifier.refreshStats", "stats refreshed"),
                logged("L3", "http", "GET /books", "listed 30 books"),
            ])
            .unwrap();
        let reader = Reader::new(&path);
        let messages = |query: &str| -> Vec<Value> {
            reader
                .search_logs(query, 50, None)
                .unwrap()
                .items
                .iter()
                .map(|log| log["message"].clone())
                .collect()
        };

        assert_eq!(
            messages("task:Orders.onOrder"),
            [Value::from("order for Book 5")]
        );
        assert_eq!(messages("task:Orders.*"), [Value::from("order for Book 5")]);
        assert_eq!(
            messages("job:Notifier.refreshStats"),
            [Value::from("stats refreshed")]
        );
        assert_eq!(messages("kind:http"), [Value::from("listed 30 books")]);
        // A job of the same name is no task.
        assert_eq!(messages("task:Notifier.refreshStats"), Vec::<Value>::new());
        // What ran the tasks, for the Tasks page's System menu: only what this project has.
        assert_eq!(
            reader.known_values("").unwrap()["task_system"],
            serde_json::json!(["rabbitmq"])
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
