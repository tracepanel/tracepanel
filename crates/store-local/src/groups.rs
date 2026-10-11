//! Groups of traces: endpoints, tasks, WebSocket consumers, GraphQL operations and jobs, their details, and the overview.

use super::*;

pub(crate) const COMMAND: &str = "json_extract(doc, '$.attrs.\"command.name\"')";
pub(crate) const OPERATION_TYPE: &str = "json_extract(doc, '$.attrs.\"graphql.operation.type\"')";
pub(crate) const OPERATION_NAME: &str = "json_extract(doc, '$.attrs.\"graphql.operation.name\"')";
pub(crate) const WAIT: &str = "json_extract(doc, '$.attrs.\"task.queue_wait\"')";
pub(crate) const WS_EVENT: &str = "json_extract(doc, '$.attrs.\"ws.event\"')";
pub(crate) const WS_LIFECYCLE: [&str; 3] = ["connect", "receive", "disconnect"];

pub(crate) type Row = serde_json::Map<String, Value>;

/// Python's str() of a column value.
pub(crate) fn text_of(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => "None".into(),
        other => other.to_string(),
    }
}

/// Rows grouped by a key, in the order the keys first appear (a dict's setdefault).
pub(crate) fn grouped(rows: Vec<Row>, key: impl Fn(&Row) -> String) -> Vec<(String, Vec<Row>)> {
    let mut order: Vec<(String, Vec<Row>)> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    for row in rows {
        let name = key(&row);
        match index.get(&name) {
            Some(at) => order[*at].1.push(row),
            None => {
                index.insert(name.clone(), order.len());
                order.push((name, vec![row]));
            }
        }
    }
    order
}

pub(crate) fn durations(rows: &[Row]) -> Vec<i64> {
    let mut values: Vec<i64> = rows.iter().map(|row| int(row, "duration")).collect();
    values.sort_unstable();
    values
}

pub(crate) fn avg_queries(rows: &[Row]) -> f64 {
    round1(
        rows.iter()
            .map(|row| int(row, "queries") as f64)
            .sum::<f64>()
            / rows.len() as f64,
    )
}

pub(crate) fn with_issues(rows: &[Row]) -> usize {
    rows.iter().filter(|row| int(row, "issues") != 0).count()
}

pub(crate) fn last_seen(rows: &[Row]) -> i64 {
    rows.iter().map(|row| int(row, "start")).max().unwrap_or(0)
}

pub(crate) fn failed(rows: &[Row]) -> usize {
    rows.iter().filter(|row| row["status"] == "error").count()
}

/// Busiest first (a stable sort by total time), the first `limit`.
pub(crate) fn busiest(mut items: Vec<Value>, limit: i64) -> Vec<Value> {
    items.sort_by_key(|item| -item["total"].as_i64().unwrap_or(0));
    items.truncate(limit.max(0) as usize);
    items
}

pub(crate) fn group_stats(rows: &[Row]) -> serde_json::Map<String, Value> {
    let durations = durations(rows);
    let Value::Object(map) = serde_json::json!({
        "calls": rows.len(),
        "errors": rows.iter().filter(|row| is_error(row)).count(),
        "p95": pct(&durations, 0.95),
        "slow": durations.iter().filter(|value| **value >= SLOW_REQUEST_US).count(),
    }) else {
        unreachable!()
    };
    map
}

pub(crate) fn name_search(
    resource: &str,
    column_name: &'static str,
    extra: Vec<(&str, Compiler)>,
) -> search::Schema {
    search::schema_for(
        resource,
        &[
            (column_name, "name"),
            ("since", "start"),
            ("until", "start"),
        ],
        Box::new(|words| {
            (
                "name LIKE ? ESCAPE '\\'".into(),
                vec![Sql::Text(format!("%{}%", search::like(words)))],
            )
        }),
        extra,
        vec![],
    )
}

/// Per GraphQL field over many calls: how often it resolves per call, its time, its SQL; heaviest first.
pub(crate) fn resolver_stats(docs: &[Value]) -> Vec<Value> {
    let mut order: Vec<String> = Vec::new();
    let mut fields: HashMap<String, (i64, Vec<i64>, i64)> = HashMap::new();
    for doc in docs {
        let spans = doc["spans"].as_array().cloned().unwrap_or_default();
        let parents: HashMap<String, &Value> = spans
            .iter()
            .map(|span| (span["id"].as_str().unwrap_or("").to_owned(), span))
            .collect();
        for span in &spans {
            let Some(field) = span["attrs"]["graphql.field"].as_str() else {
                continue;
            };
            if span["kind"] != "function" {
                continue;
            }
            if !fields.contains_key(field) {
                order.push(field.to_owned());
            }
            let item = fields.entry(field.to_owned()).or_insert((0, Vec::new(), 0));
            item.0 += 1;
            item.1.push(span["duration"].as_i64().unwrap_or(0));
        }
        for span in &spans {
            if span["kind"] != "sql" {
                continue;
            }
            let parent = span["parent_id"].as_str().and_then(|id| parents.get(id));
            if let Some(field) = parent.and_then(|parent| parent["attrs"]["graphql.field"].as_str())
                && let Some(item) = fields.get_mut(field)
            {
                item.2 += 1;
            }
        }
    }
    let calls = docs.len().max(1) as f64;
    let rows: Vec<Value> = order
        .into_iter()
        .map(|field| {
            let (resolves, mut durations, queries) = fields.remove(&field).unwrap_or_default();
            durations.sort_unstable();
            serde_json::json!({
                "field": field,
                "per_call": round1(resolves as f64 / calls),
                "total": durations.iter().sum::<i64>(),
                "p95": pct(&durations, 0.95),
                "queries_per_call": round1(queries as f64 / calls),
            })
        })
        .collect();
    busiest(rows, i64::MAX)
}

impl Reader {
    /// HTTP traffic per route: calls, latency percentiles, queries per call, issues, errors.
    pub fn list_endpoints(&self, query: &str, limit: i64) -> Result<Vec<Value>, ReadError> {
        let schema = search::schema_for(
            "endpoints",
            &[("route", "route"), ("since", "start"), ("until", "start")],
            Box::new(|words| {
                (
                    "route LIKE ? ESCAPE '\\'".into(),
                    vec![Sql::Text(format!("%{}%", search::like(words)))],
                )
            }),
            vec![("method", search::upper_text("method"))],
            vec![],
        );
        let (condition, params) = search::compile_where(query, &schema)?;
        let db = self.connect()?;
        let rows = objects(
            &db,
            &format!(
                "SELECT method, route, duration, queries, issues, errors, status, http_status, start, \
                 CASE WHEN name LIKE 'GraphQL %' THEN name END AS operation FROM traces \
                 WHERE kind = 'http' AND route IS NOT NULL AND {condition}"
            ),
            params,
        )?;
        let groups = grouped(rows, |row| {
            format!("{}\u{0}{}", text_of(&row["method"]), text_of(&row["route"]))
        });
        let items = groups
            .into_iter()
            .map(|(key, rows)| {
                let (method, route) = key.split_once('\u{0}').unwrap_or_default();
                let durations = durations(&rows);
                let operations: BTreeSet<String> = rows
                    .iter()
                    .filter_map(|row| row["operation"].as_str().map(str::to_owned))
                    .collect();
                serde_json::json!({
                    "method": method,
                    "route": route,
                    "calls": rows.len(),
                    "p50": durations[durations.len() / 2],
                    "p95": pct(&durations, 0.95),
                    "total": durations.iter().sum::<i64>(),
                    "avg_queries": avg_queries(&rows),
                    "with_issues": with_issues(&rows),
                    "errors": rows.iter().filter(|row| is_error(row)).count(),
                    "last_seen": last_seen(&rows),
                    // A GraphQL endpoint serves many operations: the GraphQL page breaks them down.
                    "graphql_operations": operations.len(),
                })
            })
            .collect();
        Ok(busiest(items, limit))
    }

    /// Tasks by name: runs, failures, retries, latency, time waiting in the queue; busiest first.
    pub fn list_tasks(&self, query: &str, limit: i64) -> Result<Vec<Value>, ReadError> {
        let schema = name_search(
            "tasks",
            "task",
            vec![
                ("queue", search::text(QUEUE)),
                ("state", search::upper_text(STATE)),
                ("system", search::text(SYSTEM)),
            ],
        );
        let (condition, params) = search::compile_where(query, &schema)?;
        let db = self.connect()?;
        let rows = objects(
            &db,
            &format!(
                "SELECT name, duration, status, start, issues, queries, {SYSTEM} AS system, {QUEUE} AS queue, \
                 {STATE} AS state, {WAIT} AS wait FROM traces WHERE kind = 'task' AND {condition}"
            ),
            params,
        )?;
        let items = grouped(rows, |row| text_of(&row["name"]))
            .into_iter()
            .map(|(name, rows)| {
                let durations = durations(&rows);
                let mut waits: Vec<i64> = rows.iter().filter_map(|row| row["wait"].as_i64()).collect();
                waits.sort_unstable();
                let queues: BTreeSet<String> =
                    rows.iter().filter(|row| truthy(row.get("queue"))).map(|row| text_of(&row["queue"])).collect();
                let system = if truthy(rows[0].get("system")) { text_of(&rows[0]["system"]) } else { "celery".into() };
                serde_json::json!({
                    "task": name,
                    "system": system,
                    "runs": rows.len(),
                    "failures": rows.iter().filter(|row| row["state"] == "FAILURE").count(),
                    "retries": rows.iter().filter(|row| row["state"] == "RETRY").count(),
                    "p50": pct(&durations, 0.5),
                    "p95": pct(&durations, 0.95),
                    "total": durations.iter().sum::<i64>(),
                    "wait_p50": if waits.is_empty() { Value::Null } else { Value::from(pct(&waits, 0.5)) },
                    "wait_p95": if waits.is_empty() { Value::Null } else { Value::from(pct(&waits, 0.95)) },
                    "avg_queries": avg_queries(&rows),
                    "with_issues": with_issues(&rows),
                    "queues": queues.into_iter().collect::<Vec<_>>(),
                    "last_seen": last_seen(&rows),
                })
            })
            .collect();
        Ok(busiest(items, limit))
    }

    /// WebSocket consumers: connections, messages, errors and handler time per consumer; busiest first.
    pub fn list_websockets(&self, query: &str, limit: i64) -> Result<Vec<Value>, ReadError> {
        let schema = search::schema_for(
            "websockets",
            &[("consumer", "view"), ("since", "start"), ("until", "start")],
            Box::new(|words| {
                let pattern = Sql::Text(format!("%{}%", search::like(words)));
                (
                    "(view LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\')".into(),
                    vec![pattern.clone(), pattern],
                )
            }),
            vec![("event", search::text(WS_EVENT))],
            vec![],
        );
        let (condition, params) = search::compile_where(query, &schema)?;
        let db = self.connect()?;
        let rows = objects(
            &db,
            &format!(
                "SELECT view, duration, status, start, issues, queries, {WS_EVENT} AS event, \
                 json_extract(doc, '$.attrs.\"ws.path\"') AS ws_path \
                 FROM traces WHERE kind = 'websocket' AND view IS NOT NULL AND {condition}"
            ),
            params,
        )?;
        let items = grouped(rows, |row| text_of(&row["view"]))
            .into_iter()
            .map(|(consumer, rows)| {
                let durations = durations(&rows);
                let events: Vec<String> = rows.iter().map(|row| text_of(&row["event"])).collect();
                let count = |name: &str| events.iter().filter(|event| *event == name).count();
                let paths: BTreeSet<String> =
                    rows.iter().filter(|row| truthy(row.get("ws_path"))).map(|row| text_of(&row["ws_path"])).collect();
                serde_json::json!({
                    "consumer": consumer,
                    "connections": count("connect"),
                    "received": count("receive"),
                    "delivered": events.iter().filter(|event| !WS_LIFECYCLE.contains(&event.as_str())).count(),
                    "disconnects": count("disconnect"),
                    "errors": failed(&rows),
                    "p50": pct(&durations, 0.5),
                    "p95": pct(&durations, 0.95),
                    "total": durations.iter().sum::<i64>(),
                    "avg_queries": avg_queries(&rows),
                    "with_issues": with_issues(&rows),
                    "paths": paths.into_iter().take(5).collect::<Vec<_>>(),
                    "last_seen": last_seen(&rows),
                })
            })
            .collect();
        Ok(busiest(items, limit))
    }

    /// GraphQL operations by name: calls, errors, latency and queries per call; busiest first.
    pub fn list_graphql(&self, query: &str, limit: i64) -> Result<Vec<Value>, ReadError> {
        let schema = search::schema_for(
            "graphql",
            &[("route", "route"), ("since", "start"), ("until", "start")],
            Box::new(|words| {
                (
                    format!("{OPERATION} LIKE ? ESCAPE '\\'"),
                    vec![Sql::Text(format!("%{}%", search::like(words)))],
                )
            }),
            vec![
                ("operation", search::text(OPERATION)),
                ("type", search::text(OPERATION_TYPE)),
            ],
            vec![],
        );
        let (condition, params) = search::compile_where(query, &schema)?;
        let db = self.connect()?;
        let rows = objects(
            &db,
            &format!(
                "SELECT {OPERATION} AS operation, duration, status, start, issues, queries, \
                 {OPERATION_TYPE} AS type, {OPERATION_NAME} AS name \
                 FROM traces WHERE {OPERATION} IS NOT NULL AND {condition}"
            ),
            params,
        )?;
        let items = grouped(rows, |row| text_of(&row["operation"]))
            .into_iter()
            .map(|(operation, rows)| {
                let durations = durations(&rows);
                serde_json::json!({
                    "operation": operation,
                    "type": rows[0]["type"],
                    "name": rows[0]["name"],
                    "calls": rows.len(),
                    "errors": failed(&rows),
                    "p50": pct(&durations, 0.5),
                    "p95": pct(&durations, 0.95),
                    "total": durations.iter().sum::<i64>(),
                    "avg_queries": avg_queries(&rows),
                    "with_issues": with_issues(&rows),
                    "last_seen": last_seen(&rows),
                })
            })
            .collect();
        Ok(busiest(items, limit))
    }

    /// A group of traces (an endpoint, an operation, a task…): summary, series, histogram, issues, calls.
    fn detail(
        &self,
        condition: &str,
        params: Vec<Sql>,
        buckets: i64,
    ) -> Result<Option<Row>, ReadError> {
        let db = self.connect()?;
        let rows = objects(
            &db,
            &format!("SELECT {LISTING} FROM traces WHERE {condition} ORDER BY start"),
            params.clone(),
        )?;
        let issues = objects(
            &db,
            &format!(
                "SELECT issues.*, COUNT(issue_traces.trace_id) AS calls FROM issues \
                 JOIN issue_traces ON issue_traces.fingerprint = issues.fingerprint \
                 WHERE issue_traces.trace_id IN (SELECT id FROM traces WHERE {condition}) \
                 GROUP BY issues.fingerprint ORDER BY calls DESC"
            ),
            params,
        )?;
        if rows.is_empty() {
            return Ok(None);
        }
        let Value::Object(mut detail) = stats(&rows, buckets, None, None) else {
            unreachable!()
        };
        let traces: Vec<Value> = rows.into_iter().map(listed).collect();
        let mut slowest = traces.clone();
        slowest.sort_by_key(|item| -item["duration"].as_i64().unwrap_or(0));
        slowest.truncate(10);
        detail.insert(
            "issues".into(),
            Value::Array(issues.into_iter().map(Value::Object).collect()),
        );
        detail.insert("slowest".into(), Value::Array(slowest));
        detail.insert(
            "recent".into(),
            Value::Array(traces.into_iter().rev().take(10).collect()),
        );
        Ok(Some(detail))
    }

    /// Any group of traces, named by a search: `task:x`, `kind:command name:sync-prices`, `operation:"query X"`.
    pub fn summary(&self, query: &str, buckets: i64) -> Result<Option<Value>, ReadError> {
        let (condition, params) = search::compile_where(query, &TRACE_SEARCH)?;
        Ok(self.detail(&condition, params, buckets)?.map(|detail| {
            let mut object = Row::new();
            object.insert("query".into(), Value::from(query));
            object.extend(detail);
            Value::Object(object)
        }))
    }

    /// One endpoint: percentile summary, time series, latency histogram, issues, slowest and recent calls.
    pub fn endpoint_detail(
        &self,
        method: &str,
        route: &str,
        buckets: i64,
    ) -> Result<Option<Value>, ReadError> {
        let method = method.to_uppercase();
        let params = vec![Sql::Text(method.clone()), Sql::Text(route.to_owned())];
        Ok(self
            .detail(
                "kind = 'http' AND method = ? AND route = ?",
                params,
                buckets,
            )?
            .map(|detail| {
                let mut object = Row::new();
                object.insert("method".into(), Value::from(method));
                object.insert("route".into(), Value::from(route));
                object.extend(detail);
                Value::Object(object)
            }))
    }

    /// One GraphQL operation: like an endpoint (percentiles, series, issues, calls) plus its resolvers.
    pub fn graphql_detail(
        &self,
        operation: &str,
        buckets: i64,
    ) -> Result<Option<Value>, ReadError> {
        let condition = format!("{OPERATION} = ?");
        let Some(detail) =
            self.detail(&condition, vec![Sql::Text(operation.to_owned())], buckets)?
        else {
            return Ok(None);
        };
        let db = self.connect()?;
        let mut statement = db.prepare(&format!(
            "SELECT doc FROM traces WHERE {condition} ORDER BY start"
        ))?;
        let docs: Vec<Value> = statement
            .query_map([operation], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?
            .iter()
            .filter_map(|doc| serde_json::from_str(doc).ok())
            .collect();
        let attrs = docs
            .last()
            .map(|doc| doc["attrs"].clone())
            .unwrap_or(Value::Null);
        let mut object = Row::new();
        object.insert("operation".into(), Value::from(operation));
        object.insert(
            "type".into(),
            attrs
                .get("graphql.operation.type")
                .cloned()
                .unwrap_or(Value::Null),
        );
        object.insert(
            "name".into(),
            attrs
                .get("graphql.operation.name")
                .cloned()
                .unwrap_or(Value::Null),
        );
        object.insert(
            "document".into(),
            attrs
                .get("graphql.document")
                .cloned()
                .unwrap_or(Value::Null),
        );
        object.extend(detail);
        object.insert("resolvers".into(), Value::Array(resolver_stats(&docs)));
        Ok(Some(Value::Object(object)))
    }

    /// Jobs: management commands and `tracepanel.trace()` blocks (kind command) by name; busiest first.
    pub fn list_jobs(&self, query: &str, limit: i64) -> Result<Vec<Value>, ReadError> {
        let source = format!("CASE WHEN {COMMAND} IS NULL THEN 'custom' ELSE 'manage.py' END");
        let schema = name_search("jobs", "job", vec![("source", search::text(&source))]);
        let (condition, params) = search::compile_where(query, &schema)?;
        let db = self.connect()?;
        let rows = objects(
            &db,
            &format!(
                "SELECT name, duration, status, start, issues, queries, {source} AS source \
                 FROM traces WHERE kind = 'command' AND {condition}"
            ),
            params,
        )?;
        let items = grouped(rows, |row| text_of(&row["name"]))
            .into_iter()
            .map(|(job, rows)| {
                let durations = durations(&rows);
                serde_json::json!({
                    "job": job,
                    "source": rows[0]["source"],
                    "runs": rows.len(),
                    "failures": failed(&rows),
                    "p50": pct(&durations, 0.5),
                    "p95": pct(&durations, 0.95),
                    "total": durations.iter().sum::<i64>(),
                    "avg_queries": avg_queries(&rows),
                    "with_issues": with_issues(&rows),
                    "last_seen": last_seen(&rows),
                })
            })
            .collect();
        Ok(busiest(items, limit))
    }

    /// Monitoring over every trace matching a search, whatever its kind; `group` "endpoint" puts requests by route.
    pub fn traces_overview(
        &self,
        query: &str,
        buckets: i64,
        group: &str,
    ) -> Result<Value, ReadError> {
        let (condition, params) = search::compile_where(query, &TRACE_SEARCH)?;
        let now = search::now_us();
        let (since, until) = search::period(query, now);
        let db = self.connect()?;
        let rows = objects(
            &db,
            &format!("SELECT {LISTING} FROM traces WHERE {condition} ORDER BY start"),
            params,
        )?;
        let operations = grouped(rows.clone(), |row| {
            // An empty route (older FastAPI traces of a router's root) is no route.
            let by_endpoint =
                group == "endpoint" && row["kind"] == "http" && truthy(row.get("route"));
            let name = if by_endpoint {
                format!("{} {}", text_of(&row["method"]), text_of(&row["route"]))
            } else {
                text_of(&row["name"])
            };
            format!("{}\u{0}{name}", text_of(&row["kind"]))
        });
        let mut kinds: Vec<(String, Vec<Row>)> = grouped(rows.clone(), |row| text_of(&row["kind"]));
        kinds.sort_by(|a, b| a.0.cmp(&b.0));
        let stats_rows: Vec<Value> = operations
            .into_iter()
            .map(|(key, members)| {
                let (kind, name) = key.split_once('\u{0}').unwrap_or_default();
                let mut object = Row::new();
                object.insert("kind".into(), Value::from(kind));
                object.insert("name".into(), Value::from(name));
                // Requests link to their endpoint page.
                object.insert(
                    "method".into(),
                    if kind == "http" {
                        members[0]["method"].clone()
                    } else {
                        Value::Null
                    },
                );
                object.insert(
                    "route".into(),
                    if kind == "http" {
                        members[0]["route"].clone()
                    } else {
                        Value::Null
                    },
                );
                // WebSocket events link to their consumer's page.
                object.insert(
                    "view".into(),
                    if kind == "websocket" {
                        members[0]["view"].clone()
                    } else {
                        Value::Null
                    },
                );
                object.extend(group_stats(&members));
                Value::Object(object)
            })
            .collect();
        let mut slowest = stats_rows.clone();
        slowest.sort_by_key(|item| -item["p95"].as_i64().unwrap_or(0));
        slowest.truncate(6);
        let mut failing: Vec<Value> = stats_rows
            .into_iter()
            .filter(|item| item["errors"].as_i64().unwrap_or(0) != 0)
            .collect();
        failing.sort_by_key(|item| -item["errors"].as_i64().unwrap_or(0));
        failing.truncate(6);
        let Value::Object(mut overview) = stats(&rows, buckets, since, Some(until.unwrap_or(now)))
        else {
            unreachable!()
        };
        overview.insert("slow_threshold".into(), Value::from(SLOW_REQUEST_US));
        overview.insert(
            "kinds".into(),
            Value::Array(
                kinds
                    .into_iter()
                    .map(|(kind, members)| {
                        let mut object = Row::new();
                        object.insert("kind".into(), Value::from(kind));
                        object.extend(group_stats(&members));
                        Value::Object(object)
                    })
                    .collect(),
            ),
        );
        overview.insert("slowest".into(), Value::Array(slowest));
        overview.insert("failing".into(), Value::Array(failing));
        Ok(Value::Object(overview))
    }
}
