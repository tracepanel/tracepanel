//! What each page of the console calls slow: the time its "Slower than" filter offers first. A system's page is slow
//! from where the agent raises its slow-call issue, with each app's limits (a warehouse's own for SQL); the pages of
//! requests, tasks and the rest from `SLOW_REQUEST_US`, as their charts mark them.

use super::*;
use std::collections::BTreeMap;
use tracepanel_analysis::calls::slow_ms;
use tracepanel_protocol::Thresholds;

/// The pages whose rows are traces (requests, tasks, jobs…): slow from `SLOW_REQUEST_US`.
const ENTRY_PAGES: [&str; 8] = [
    "traces",
    "endpoints",
    "graphql",
    "tasks",
    "websockets",
    "jobs",
    "rpc",
    "pages",
];

/// One system's calls, as a page has them: its family, a SQL call's database, the app that made them.
struct Seen {
    family: String,
    system: String,
    vendor: Option<String>,
    service: String,
}

impl Reader {
    /// `{"calls/sql": {"ms": 100, "mixed": false}, "endpoints": {"ms": 500, …}}`: from how many milliseconds each page
    /// calls a row slow, with each app's limits (`limits`, by service.name; the defaults for an app not in it). Its
    /// apps and databases may disagree (an app's own limit, a warehouse beside PostgreSQL): the page then has the
    /// lowest of the defaults for its databases, and says it is `mixed`. A system with no slow issue (Redis, a
    /// broker, a model) has none. With `service`, only that app's calls count.
    pub fn slow_limits(
        &self,
        service: &str,
        limits: &HashMap<String, Thresholds>,
    ) -> Result<Value, ReadError> {
        let db = self.connect()?;
        let scope = if service.is_empty() {
            "1"
        } else {
            "traces.service = ?1"
        };
        let mut statement = db.prepare(&format!(
            "SELECT DISTINCT calls.system, calls.family, \
             CASE WHEN calls.family = 'sql' THEN calls.vendor END, traces.service \
             FROM calls JOIN traces ON traces.id = calls.trace_id WHERE {scope}"
        ))?;
        let params: Vec<&dyn rusqlite::ToSql> = if statement.parameter_count() == 0 {
            vec![]
        } else {
            vec![&service]
        };
        let mut pages: BTreeMap<String, Vec<Seen>> = BTreeMap::new();
        let rows = statement.query_map(params.as_slice(), |row| {
            Ok(Seen {
                system: row.get(0)?,
                family: row.get(1)?,
                vendor: row.get(2)?,
                service: row.get(3)?,
            })
        })?;
        for seen in rows {
            let seen = seen?;
            pages
                .entry(format!("calls/{}", seen.system))
                .or_default()
                .push(seen);
        }
        let mut slow = serde_json::Map::new();
        for page in ENTRY_PAGES {
            slow.insert(
                page.into(),
                serde_json::json!({"ms": SLOW_REQUEST_US / 1000, "mixed": false}),
            );
        }
        let defaults = Thresholds::default();
        for (page, seen) in pages {
            let of = |each: &Seen, thresholds: &Thresholds| {
                slow_ms(
                    thresholds,
                    &each.family,
                    &each.system,
                    each.vendor.as_deref(),
                )
            };
            let own: BTreeSet<Option<i64>> = seen
                .iter()
                .map(|each| of(each, limits.get(&each.service).unwrap_or(&defaults)))
                .collect();
            let limit = if let [Some(ms)] = own.iter().collect::<Vec<_>>()[..] {
                Some((*ms, false))
            } else {
                seen.iter()
                    .filter_map(|each| of(each, &defaults))
                    .min()
                    .map(|ms| (ms, true))
            };
            if let Some((ms, mixed)) = limit {
                slow.insert(page, serde_json::json!({"ms": ms, "mixed": mixed}));
            }
        }
        Ok(Value::Object(slow))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A span of `kind` under the root, `ms` long, with `attrs`.
    fn span(id: &str, kind: &str, name: &str, start: i64, ms: i64, attrs: Value) -> Value {
        serde_json::json!({
            "id": id, "parent_id": "root", "kind": kind, "name": name, "start": start, "duration": ms * 1000,
            "status": "ok", "attrs": attrs,
        })
    }

    /// A query on `system` (PostgreSQL, Snowflake…), `ms` long.
    fn query(id: &str, sql: &str, system: &str, start: i64, ms: i64) -> Value {
        span(
            id,
            "sql",
            sql,
            start,
            ms,
            serde_json::json!({"db.alias": "default", "db.system": system, "db.fingerprint": sql, "db.statement": sql}),
        )
    }

    /// `GET /books` of `service`, `ms` long, making `spans`.
    fn request(id: &str, service: &str, start: i64, ms: i64, mut spans: Vec<Value>) -> Received {
        spans.insert(
            0,
            serde_json::json!({
                "id": "root", "parent_id": null, "kind": "http", "name": "GET /books", "start": start,
                "duration": ms * 1000, "status": "ok", "attrs": {},
            }),
        );
        let doc = serde_json::json!({
            "id": id, "kind": "http", "name": "GET /books", "start": start, "duration": ms * 1000, "status": "ok",
            "attrs": {"service.name": service, "http.method": "GET", "http.route": "/books"},
            "spans": spans, "logs": [], "errors": [], "links": [], "issues": [],
        });
        Received {
            trace: serde_json::from_value(doc.clone()).unwrap(),
            doc: doc.to_string(),
        }
    }

    fn store(name: &str, traces: &[Received]) -> (PathBuf, Reader) {
        let dir = std::env::temp_dir().join(format!(
            "tracepanel-store-slow-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let path = path_in(&dir);
        Store::open(&path).unwrap().write(traces).unwrap();
        (dir, Reader::new(&path))
    }

    const BOOK: &str = "SELECT * FROM book WHERE id = %s";
    const AUTHOR: &str = "SELECT * FROM author";

    /// Two requests: the first's book queries take 50, 600 and 700 ms, its author query 20; the second's book query
    /// 800 ms, its author query 10.
    fn two_requests() -> Vec<Received> {
        vec![
            request(
                "t1",
                "shop",
                1_000,
                1_500,
                vec![
                    query("q1", BOOK, "postgresql", 1_001, 50),
                    query("q2", BOOK, "postgresql", 1_002, 600),
                    query("q3", BOOK, "postgresql", 1_003, 700),
                    query("q4", AUTHOR, "postgresql", 1_004, 20),
                ],
            ),
            request(
                "t2",
                "shop",
                2_000,
                300,
                vec![
                    query("q5", BOOK, "postgresql", 2_001, 800),
                    query("q6", AUTHOR, "postgresql", 2_002, 10),
                ],
            ),
        ]
    }

    fn numbers(rows: &[Value]) -> Vec<Value> {
        rows.iter()
            .map(|row| {
                serde_json::json!({
                    "template": row["template"], "calls": row["calls"], "all_calls": row["all_calls"],
                    "traces": row["traces"], "total": row["total"], "slowest": row["slowest"],
                    "most_per_trace": row["most_per_trace"], "sample_trace": row["sample_trace"],
                    "sample_span": row["sample_span"],
                })
            })
            .collect()
    }

    #[test]
    fn a_group_slower_than_a_time_is_its_slow_calls_of_all_of_them() {
        let (dir, reader) = store("calls", &two_requests());

        assert_eq!(
            numbers(&reader.list_calls("system:sql", 50).unwrap()),
            [
                serde_json::json!({"template": BOOK, "calls": 4, "all_calls": null, "traces": 2,
                                   "total": 2_150_000, "slowest": 800_000, "most_per_trace": 3,
                                   "sample_trace": "t2", "sample_span": "q5"}),
                serde_json::json!({"template": AUTHOR, "calls": 2, "all_calls": null, "traces": 2,
                                   "total": 30_000, "slowest": 20_000, "most_per_trace": 1,
                                   "sample_trace": "t2", "sample_span": "q6"}),
            ]
        );

        // The book query's slow calls alone, of its four; the author query has none and is gone.
        assert_eq!(
            numbers(&reader.list_calls("system:sql duration>500ms", 50).unwrap()),
            [
                serde_json::json!({"template": BOOK, "calls": 3, "all_calls": 4, "traces": 2,
                                "total": 2_100_000, "slowest": 800_000, "most_per_trace": 2,
                                "sample_trace": "t2", "sample_span": "q5"})
            ]
        );

        // A group's latest call is its latest slow one: the second request's author query is too fast.
        assert_eq!(
            numbers(&reader.list_calls("duration>15ms system:sql", 50).unwrap()),
            [
                serde_json::json!({"template": BOOK, "calls": 4, "all_calls": 4, "traces": 2,
                                   "total": 2_150_000, "slowest": 800_000, "most_per_trace": 3,
                                   "sample_trace": "t2", "sample_span": "q5"}),
                serde_json::json!({"template": AUTHOR, "calls": 1, "all_calls": 2, "traces": 1,
                                   "total": 20_000, "slowest": 20_000, "most_per_trace": 1,
                                   "sample_trace": "t1", "sample_span": "q4"}),
            ]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_groups_requests_slower_than_a_time_are_those_where_its_call_was() {
        let (dir, reader) = store("traces", &two_requests());
        let keys: HashMap<String, String> = reader
            .list_calls("system:sql", 50)
            .unwrap()
            .into_iter()
            .map(|row| {
                (
                    row["template"].as_str().unwrap().to_owned(),
                    row["key"].as_str().unwrap().to_owned(),
                )
            })
            .collect();
        let found = |query: &str| -> Vec<Value> {
            let page = reader.search_traces(query, 50, None).unwrap();
            page.items
                .into_iter()
                .map(|item| item["id"].clone())
                .collect()
        };

        assert_eq!(
            found(&format!("call:{} call_duration>750ms", keys[BOOK])),
            ["t2"]
        );

        // The second request has a call that slow, but not this one; the filters in either order.
        assert_eq!(
            found(&format!("call:{} call_duration>15ms", keys[AUTHOR])),
            ["t1"]
        );
        assert_eq!(
            found(&format!("call_duration>15ms call:{}", keys[AUTHOR])),
            ["t1"]
        );

        // Without call:, any call that slow.
        assert_eq!(found("call_duration>650ms"), ["t2", "t1"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_entry_points_rows_slower_than_a_time_say_of_how_many() {
        let (dir, reader) = store("endpoints", &two_requests());
        let rows = |query: &str| -> Vec<Value> {
            reader
                .list_endpoints(query, 50)
                .unwrap()
                .into_iter()
                .map(|row| {
                    serde_json::json!({"route": row["route"], "calls": row["calls"],
                                       "all_calls": row["all_calls"], "p50": row["p50"]})
                })
                .collect()
        };

        assert_eq!(
            rows(""),
            [
                serde_json::json!({"route": "/books", "calls": 2, "all_calls": null, "p50": 1_500_000})
            ]
        );

        assert_eq!(
            rows("duration>1s"),
            [serde_json::json!({"route": "/books", "calls": 1, "all_calls": 2, "p50": 1_500_000})]
        );

        assert_eq!(rows("duration>2s"), Vec::<Value>::new());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_page_is_slow_from_its_apps_limits_and_a_warehouse_from_its_own() {
        let traces = vec![
            request(
                "t1",
                "shop",
                1_000,
                100,
                vec![
                    query("q1", BOOK, "postgresql", 1_001, 50),
                    span(
                        "h1",
                        "http.client",
                        "GET",
                        1_002,
                        10,
                        serde_json::json!({"http.method": "GET", "url.full": "https://api.example.com/rates",
                                           "server.address": "api.example.com"}),
                    ),
                    span(
                        "r1",
                        "redis",
                        "GET k",
                        1_003,
                        1,
                        serde_json::json!({"db.system": "redis", "db.operation": "GET", "redis.alias": "redis",
                                           "redis.key": "k"}),
                    ),
                ],
            ),
            request(
                "t2",
                "lake",
                2_000,
                100,
                vec![query("q2", AUTHOR, "snowflake", 2_001, 50)],
            ),
        ];
        let (dir, reader) = store("limits", &traces);
        let shop = Thresholds {
            slow_sql_ms: 250,
            slow_http_ms: 800,
            ..Thresholds::default()
        };
        let limits = HashMap::from([("shop".to_owned(), shop)]);
        let entry = serde_json::json!({"ms": 500, "mixed": false});
        let with = |pages: Value| -> Value {
            let mut all = serde_json::json!({
                "traces": entry, "endpoints": entry, "graphql": entry, "tasks": entry, "websockets": entry,
                "jobs": entry, "rpc": entry, "pages": entry,
            });
            for (page, limit) in pages.as_object().unwrap() {
                all[page] = limit.clone();
            }
            all
        };

        // PostgreSQL by the shop's own limit beside Snowflake by a warehouse's: the lowest default, mixed. Redis has
        // no slow issue.
        assert_eq!(
            reader.slow_limits("", &limits).unwrap(),
            with(serde_json::json!({
                "calls/sql": {"ms": 100, "mixed": true},
                "calls/http": {"ms": 800, "mixed": false},
            }))
        );

        // One app: its own limits, a warehouse's for a warehouse.
        assert_eq!(
            reader.slow_limits("shop", &limits).unwrap(),
            with(serde_json::json!({
                "calls/sql": {"ms": 250, "mixed": false},
                "calls/http": {"ms": 800, "mixed": false},
            }))
        );
        assert_eq!(
            reader.slow_limits("lake", &limits).unwrap(),
            with(serde_json::json!({"calls/sql": {"ms": 2000, "mixed": false}}))
        );

        // An app that said nothing of its limits has the defaults.
        assert_eq!(
            reader.slow_limits("", &HashMap::new()).unwrap()["calls/http"],
            serde_json::json!({"ms": 500, "mixed": false})
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
