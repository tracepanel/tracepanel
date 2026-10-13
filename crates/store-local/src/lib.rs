//! Local SQLite storage: a project's traces, logs, queries, emails and issues, and the console's reads of them. Some
//! conventions come from the store's Python origins and show in the API: "falsy" values fall back to defaults,
//! attribute values are compared as Python's `str()` writes them, booleans are 0/1.

use rusqlite::types::Value as Sql;
use rusqlite::{Connection, params};
use serde_json::Value;
use sha1::{Digest, Sha1};
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use tracepanel_analysis::calls::Operation;
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
pub use values::{call_key, query_fingerprint};
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
        assert_eq!(query_fingerprint("SELECT 1", "default").len(), 16);
    }

    #[test]
    fn an_operation_s_key_is_its_system_target_op_template_and_via() {
        let operation = |system: &str, target: &str, via: Option<&'static str>| Operation {
            system: system.into(),
            family: "http",
            target: target.into(),
            op: "GET".into(),
            template: "/users/{id}".into(),
            name: String::new(),
            statement: None,
            vendor: None,
            params_hash: None,
            via,
            hit: None,
        };
        let key = call_key(&operation("http", "api.example.com", None));
        assert_eq!(key.len(), 16);
        assert_eq!(key, call_key(&operation("http", "api.example.com", None)));
        assert_ne!(key, call_key(&operation("http", "other.example.com", None)));
        assert_ne!(key, call_key(&operation("grpc", "api.example.com", None)));
        assert_ne!(
            key,
            call_key(&operation("http", "api.example.com", Some("cache")))
        );
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
            serde_json::json!({"http": 1, "graphql": 0, "tasks": 0, "websockets": 0, "jobs": 0,
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
}
