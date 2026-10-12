//! Local SQLite storage: a project's traces, logs, queries, emails and issues, and the console's reads of them. Some
//! conventions come from the store's Python origins and show in the API: "falsy" values fall back to defaults,
//! attribute values are compared as Python's `str()` writes them, booleans are 0/1.

use rusqlite::types::Value as Sql;
use rusqlite::{Connection, params};
use serde_json::Value;
use sha1::{Digest, Sha1};
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
pub use values::{cache_key, call_key, query_fingerprint, redis_key};
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
    fn an_endpoint_s_key_is_its_method_host_and_template() {
        let key = call_key("GET", "api.example.com", "/users/{id}");
        assert_eq!(key.len(), 16);
        assert_eq!(key, call_key("GET", "api.example.com", "/users/{id}"));
        assert_ne!(key, call_key("POST", "api.example.com", "/users/{id}"));
        assert_ne!(key, call_key("GET", "other.example.com", "/users/{id}"));
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
            calls(reader.list_redis("", 50).unwrap()),
            [Value::from(3), Value::from(1)]
        );
        assert_eq!(calls(reader.list_cache("", 50).unwrap()), [Value::from(3)]);
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
    fn cache_and_redis_lists_take_the_same_filters() {
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
                reader.list_cache("db:default op:GET", 50).unwrap(),
                &[
                    "op",
                    "template",
                    "system",
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
                reader.list_redis("", 50).unwrap(),
                &["command", "template", "via", "calls", "errors"]
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
                    .list_redis("failed:true via:direct op:incr", 50)
                    .unwrap(),
                &["command"]
            ),
            [vec![Value::from("INCR")]]
        );
        assert!(reader.list_redis("via:task", 50).unwrap().is_empty());
        assert!(reader.list_cache("failed:true", 50).unwrap().is_empty());

        let known = reader.known_values("").unwrap();
        assert_eq!(
            (
                known["redis"].clone(),
                known["cache"].clone(),
                known["host"].clone()
            ),
            (
                serde_json::json!(["redis"]),
                serde_json::json!(["default"]),
                serde_json::json!([])
            )
        );
        let counts = reader.counts(None).unwrap();
        assert_eq!(
            counts["sections"],
            serde_json::json!({"http": 1, "graphql": 0, "tasks": 0, "websockets": 0, "jobs": 0, "calls": false,
                               "redis": true, "cache": true})
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
