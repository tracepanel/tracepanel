//! Reading for the console: the reader, row helpers, one trace and its relations, lists with cursors, logs, queries, emails, issues, services, counts.

use super::*;

/// The columns a trace has in lists.
pub(crate) const LISTING: &str = "id, kind, name, start, duration, status, http_status, method, path, route, view, user_id, \
    queries, db_time, issues, issue_kinds, errors, logs, mails, db_aliases, cache_aliases, task_state, htmx";
pub(crate) const LIST_COLUMNS: [&str; 3] = ["issue_kinds", "db_aliases", "cache_aliases"];
pub(crate) const RELATED_LIMIT: i64 = 100;

/// A connection per call: WAL lets readers run beside the writer.
pub struct Reader {
    path: PathBuf,
}

pub(crate) fn json_value(value: rusqlite::types::ValueRef<'_>) -> Value {
    use rusqlite::types::ValueRef;
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(int) => Value::from(int),
        ValueRef::Real(float) => Value::from(float),
        ValueRef::Text(text) => Value::from(String::from_utf8_lossy(text).into_owned()),
        ValueRef::Blob(blob) => Value::from(String::from_utf8_lossy(blob).into_owned()),
    }
}

/// A row as a JSON object, column by column (`dict(row)`).
pub(crate) fn row_object(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<serde_json::Map<String, Value>> {
    let statement = row.as_ref();
    let mut object = serde_json::Map::new();
    for (index, name) in statement.column_names().iter().enumerate() {
        object.insert((*name).to_owned(), json_value(row.get_ref(index)?));
    }
    Ok(object)
}

/// A trace in a list: its columns, with ",a,b," lists as arrays (`_trace_row`).
pub(crate) fn trace_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let mut object = row_object(row)?;
    for column in LIST_COLUMNS {
        let raw = object
            .remove(column)
            .and_then(|value| value.as_str().map(str::to_owned))
            .unwrap_or_default();
        let values: Vec<Value> = raw
            .split(',')
            .filter(|part| !part.is_empty())
            .map(Value::from)
            .collect();
        object.insert(column.to_owned(), Value::Array(values));
    }
    Ok(Value::Object(object))
}

/// A search page: rows, and the cursor (`before`) of the next page.
pub struct Page {
    pub items: Vec<Value>,
    pub next: Option<i64>,
}

/// Errors reading the store: a query the user can fix (400), or the store's own (500).
#[derive(Debug)]
pub enum ReadError {
    Search(String),
    Store(rusqlite::Error),
}

impl From<rusqlite::Error> for ReadError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Store(error)
    }
}

impl From<SearchError> for ReadError {
    fn from(error: SearchError) -> Self {
        Self::Search(error.0)
    }
}

/// Rows as JSON objects (`dict(row)`).
pub(crate) fn objects(
    db: &Connection,
    sql: &str,
    params: Vec<Sql>,
) -> rusqlite::Result<Vec<serde_json::Map<String, Value>>> {
    let mut statement = db.prepare(sql)?;
    let rows = statement.query_map(rusqlite::params_from_iter(params), row_object)?;
    rows.collect()
}

pub(crate) fn marks(count: usize) -> String {
    vec!["?"; count].join(", ")
}

/// What names a group of calls: the same for each call in it (its key is made of them), read from its latest call.
const NAMING: &str = "system, family, target, op, template, name, statement, vendor, via";

/// The calls matching `query` grouped by `key`, heaviest first: what names a group (`NAMING`), then the fields every
/// group has: `calls`, `traces`, `errors`, `total`, `slowest`, `last_seen`, `most_per_trace` (the most in one trace),
/// a cache's `hits` and `misses` (null for the others), `origin` (the most common line of code) and the latest call
/// (`sample_trace`, `sample_span`), which the console opens.
///
/// The numbers come from the `calls_group` index alone, per trace first and then per group (named: without
/// statistics, SQLite would take `calls_system` for `system:` and read the table row by row); what names a group and
/// the latest call come from one row each. Taking them by MAX() over every call read the whole table twice.
pub(crate) fn aggregate(
    db: &Connection,
    query: &str,
    limit: i64,
) -> Result<Vec<serde_json::Map<String, Value>>, ReadError> {
    let (condition, mut params) = search::compile_where(query, &CALLS_SEARCH)?;
    params.push(Sql::Integer(limit));
    let rows = objects(
        db,
        &format!(
            "SELECT key, SUM(n) AS calls, COUNT(*) AS traces, SUM(errors) AS errors, SUM(total) AS total, \
             MAX(slowest) AS slowest, MAX(last) AS last_seen, MAX(n) AS most_per_trace, \
             SUM(hits) AS hits, SUM(misses) AS misses \
             FROM (SELECT key, COUNT(*) AS n, SUM(error) AS errors, SUM(duration) AS total, \
             MAX(duration) AS slowest, MAX(start) AS last, \
             COALESCE(SUM(hit = 1), 0) AS hits, COALESCE(SUM(hit = 0), 0) AS misses \
             FROM calls INDEXED BY calls_group WHERE {condition} GROUP BY key, trace_id) \
             GROUP BY key ORDER BY total DESC LIMIT ?"
        ),
        params,
    )?;
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let keys: Vec<Sql> = rows
        .iter()
        .map(|row| Sql::Text(row["key"].as_str().unwrap_or("").to_owned()))
        .collect();
    let marks = marks(keys.len());
    let text_of =
        |row: &serde_json::Map<String, Value>| row["key"].as_str().unwrap_or("").to_owned();
    // The latest call of each group: the console opens it (and explains it, for SQL), and it names the group.
    let latest: Vec<Sql> = objects(
        db,
        &format!("SELECT rowid AS id, MAX(start) FROM calls WHERE key IN ({marks}) GROUP BY key"),
        keys.clone(),
    )?
    .iter()
    .filter_map(|row| row["id"].as_i64().map(Sql::Integer))
    .collect();
    let mut naming: HashMap<String, serde_json::Map<String, Value>> = objects(
        db,
        &format!(
            "SELECT key, trace_id AS sample_trace, span_id AS sample_span, {NAMING} FROM calls \
             WHERE rowid IN ({})",
            self::marks(latest.len())
        ),
        latest,
    )?
    .into_iter()
    .map(|row| (text_of(&row), row))
    .collect();
    // The most common line of code in each group, the first seen on a tie (from the index too).
    let mut origins: HashMap<String, (i64, i64, String)> = HashMap::new();
    for row in objects(
        db,
        &format!(
            "SELECT key, origin, COUNT(*) AS n, MIN(rowid) AS first FROM calls \
             WHERE key IN ({marks}) AND origin IS NOT NULL GROUP BY key, origin"
        ),
        keys,
    )? {
        let (n, first) = (
            row["n"].as_i64().unwrap_or(0),
            row["first"].as_i64().unwrap_or(0),
        );
        let origin = row["origin"].as_str().unwrap_or("").to_owned();
        let best = origins
            .entry(text_of(&row))
            .or_insert((0, i64::MAX, String::new()));
        if n > best.0 || (n == best.0 && first < best.1) {
            *best = (n, first, origin);
        }
    }
    Ok(rows
        .into_iter()
        .map(|mut row| {
            let group = text_of(&row);
            let named = naming.remove(&group).unwrap_or_default();
            let cache = named.get("family").and_then(Value::as_str) == Some("cache");
            for field in ["hits", "misses"] {
                if !cache {
                    row.insert(field.into(), Value::Null);
                }
            }
            for field in NAMING.split(", ").chain(["sample_trace", "sample_span"]) {
                row.insert(
                    field.into(),
                    named.get(field).cloned().unwrap_or(Value::Null),
                );
            }
            row.insert(
                "origin".into(),
                origins
                    .remove(&group)
                    .map_or(Value::Null, |(_, _, origin)| Value::from(origin)),
            );
            row
        })
        .collect())
}

pub(crate) fn objects_of(rows: Vec<serde_json::Map<String, Value>>) -> Vec<Value> {
    rows.into_iter().map(Value::Object).collect()
}

/// A trace row from `SELECT LISTING`, as `_trace_row` makes it for the API.
pub(crate) fn listed(row: serde_json::Map<String, Value>) -> Value {
    let mut row = row;
    for column in LIST_COLUMNS {
        let raw = row
            .remove(column)
            .and_then(|value| value.as_str().map(str::to_owned))
            .unwrap_or_default();
        row.insert(
            column.to_owned(),
            Value::Array(
                raw.split(',')
                    .filter(|p| !p.is_empty())
                    .map(Value::from)
                    .collect(),
            ),
        );
    }
    Value::Object(row)
}

pub(crate) fn issue_endpoints(db: &Connection, fingerprint: &str) -> rusqlite::Result<Vec<Value>> {
    let rows = objects(
        db,
        "SELECT DISTINCT traces.method, traces.route FROM issue_traces \
         JOIN traces ON traces.id = issue_traces.trace_id \
         WHERE issue_traces.fingerprint = ? AND traces.route IS NOT NULL ORDER BY 1, 2",
        vec![Sql::Text(fingerprint.to_owned())],
    )?;
    Ok(rows
        .into_iter()
        .map(|row| {
            let text = |key: &str| match &row[key] {
                Value::String(text) => text.clone(),
                Value::Null => "None".into(),
                other => other.to_string(),
            };
            Value::from(format!("{} {}", text("method"), text("route")))
        })
        .collect())
}

impl Reader {
    /// Sent emails, newest first, with the request that sent them.
    pub fn list_mails(
        &self,
        query: &str,
        limit: i64,
        before: Option<i64>,
    ) -> Result<Page, ReadError> {
        let (mut condition, mut params) = search::compile_where(query, &MAIL_SEARCH)?;
        if let Some(before) = before {
            condition.push_str(" AND mails.time < ?");
            params.push(Sql::Integer(before));
        }
        params.push(Sql::Integer(limit + 1));
        let db = self.connect()?;
        let mut rows = objects(
            &db,
            &format!(
                "SELECT mails.*, traces.kind AS trace_kind, traces.htmx AS trace_htmx, traces.method, traces.path, \
                 traces.name AS trace_name FROM mails \
                 JOIN traces ON traces.id = mails.trace_id WHERE {condition} ORDER BY mails.time DESC LIMIT ?"
            ),
            params,
        )?;
        let more = rows.len() as i64 > limit;
        rows.truncate(limit as usize);
        let items: Vec<Value> = rows
            .into_iter()
            .map(|mut row| {
                let recipients: Vec<Value> = row["recipients"]
                    .as_str()
                    .unwrap_or("")
                    .split(',')
                    .filter(|address| !address.is_empty())
                    .map(Value::from)
                    .collect();
                row.insert("recipients".into(), Value::Array(recipients));
                let sent = match &row["sent"] {
                    Value::Null => Value::Null,
                    value => Value::Bool(value.as_i64().unwrap_or(0) != 0),
                };
                row.insert("sent".into(), sent);
                row.insert(
                    "html".into(),
                    Value::Bool(row["html"].as_i64().unwrap_or(0) != 0),
                );
                Value::Object(row)
            })
            .collect();
        let next = if more {
            items.last().and_then(|item| item["time"].as_i64())
        } else {
            None
        };
        Ok(Page { items, next })
    }

    /// Distinct routes, loggers, database, Redis and cache aliases, hosts called and extra= keys: what the console
    /// offers in menus and hints.
    /// With `service`, only that app's: the menus offer what its pages can find.
    pub fn known_values(&self, service: &str) -> Result<Value, ReadError> {
        let db = self.connect()?;
        // Traces of the app; logs and SQL rows through their trace.
        let (traces, of_trace) = if service.is_empty() {
            ("1", "1")
        } else {
            (
                "service = ?1",
                "trace_id IN (SELECT id FROM traces WHERE service = ?1)",
            )
        };
        let distinct = |sql: &str| -> rusqlite::Result<Value> {
            let mut statement = db.prepare(sql)?;
            let params: Vec<&dyn rusqlite::ToSql> = if statement.parameter_count() == 0 {
                vec![]
            } else {
                vec![&service]
            };
            let values: Vec<Value> = statement
                .query_map(params.as_slice(), |row| Ok(json_value(row.get_ref(0)?)))?
                .collect::<Result<Vec<_>, _>>()?
                .into_iter()
                .map(|value| match value {
                    Value::String(text) => Value::String(text),
                    other => Value::String(other.to_string()),
                })
                .collect();
            Ok(Value::Array(values))
        };
        Ok(serde_json::json!({
            "route": distinct(&format!("SELECT DISTINCT route FROM traces WHERE route != '' AND {traces} ORDER BY 1"))?,
            "logger": distinct(&format!("SELECT DISTINCT logger FROM logs WHERE {of_trace} ORDER BY 1"))?,
            "db": distinct(&format!("SELECT DISTINCT target FROM calls WHERE system = 'sql' AND {of_trace} ORDER BY 1"))?,
            "targets": by_system(&db, "target", of_trace, service)?,
            "ops": by_system(&db, "op", of_trace, service)?,
            "task": distinct(&format!("SELECT DISTINCT name FROM traces WHERE kind = 'task' AND {traces} ORDER BY 1"))?,
            "job": distinct(&format!("SELECT DISTINCT name FROM traces WHERE kind = 'command' AND {traces} ORDER BY 1"))?,
            "rpc": distinct(&format!("SELECT DISTINCT name FROM traces WHERE kind = 'rpc' AND {traces} ORDER BY 1"))?,
            "page": distinct(&format!("SELECT DISTINCT name FROM traces WHERE kind = 'page' AND {traces} ORDER BY 1"))?,
            "queue": distinct(&format!(
                "SELECT DISTINCT {QUEUE} FROM traces WHERE kind = 'task' AND {QUEUE} IS NOT NULL AND {traces} ORDER BY 1"
            ))?,
            "extra": distinct(&format!(
                "SELECT DISTINCT json_each.key FROM (SELECT attrs FROM logs WHERE {of_trace}) AS logs, \
                 json_each(logs.attrs) WHERE json_each.key LIKE 'extra.%' ORDER BY 1"
            ))?,
        }))
    }

    /// Issues by fingerprint, most recent first, with their endpoints.
    pub fn list_issues(&self, query: &str, limit: i64) -> Result<Vec<Value>, ReadError> {
        let (condition, mut params) = search::compile_where(query, &ISSUE_SEARCH)?;
        params.push(Sql::Integer(limit));
        let db = self.connect()?;
        let rows = objects(
            &db,
            &format!("SELECT * FROM issues WHERE {condition} ORDER BY last_seen DESC LIMIT ?"),
            params,
        )?;
        rows.into_iter()
            .map(|mut row| {
                let fingerprint = row["fingerprint"].as_str().unwrap_or("").to_owned();
                row.insert(
                    "endpoints".into(),
                    Value::Array(issue_endpoints(&db, &fingerprint)?),
                );
                Ok(Value::Object(row))
            })
            .collect()
    }

    /// One issue: its group row, endpoints, events over time and the requests it happened in (newest first).
    /// One issue: what it is, and its traces and series over the period `query` gives (all of them without one).
    pub fn issue_detail(
        &self,
        fingerprint: &str,
        query: &str,
        buckets: i64,
        limit: usize,
    ) -> Result<Option<Value>, ReadError> {
        let (condition, mut params) = search::compile_where(query, &TRACE_SEARCH)?;
        let now = search::now_us();
        let (since, until) = search::period(query, now);
        let db = self.connect()?;
        let Some(mut row) = objects(
            &db,
            "SELECT * FROM issues WHERE fingerprint = ?",
            vec![Sql::Text(fingerprint.to_owned())],
        )?
        .pop() else {
            return Ok(None);
        };
        params.insert(0, Sql::Text(fingerprint.to_owned()));
        let rows = objects(
            &db,
            &format!(
                "SELECT {LISTING} FROM traces WHERE id IN (SELECT trace_id FROM issue_traces WHERE fingerprint = ?) \
                 AND ({condition}) ORDER BY start"
            ),
            params,
        )?;
        let series = if rows.is_empty() {
            Value::Array(vec![])
        } else {
            stats(&rows, buckets, since, Some(until.unwrap_or(now)))["series"].clone()
        };
        row.insert(
            "endpoints".into(),
            Value::Array(issue_endpoints(&db, fingerprint)?),
        );
        row.insert("series".into(), series);
        row.insert(
            "traces".into(),
            Value::Array(rows.into_iter().rev().take(limit).map(listed).collect()),
        );
        Ok(Some(Value::Object(row)))
    }

    /// What the project's web, workers and commands call, and how much: the nodes and edges of a service map.
    pub fn list_services(&self, query: &str) -> Result<Value, ReadError> {
        let (condition, params) = search::compile_where(query, &SERVICE_SEARCH)?;
        let db = self.connect()?;
        let rows = objects(
            &db,
            &format!(
                "SELECT service, role, peer, kind, system, address, port, namespace, direction, \
                 GROUP_CONCAT(DISTINCT alias) AS aliases, COUNT(DISTINCT trace_id) AS traces, SUM(calls) AS calls, \
                 SUM(duration) AS total, SUM(errors) AS errors, MAX(start) AS last_seen \
                 FROM peers WHERE {condition} GROUP BY service, role, peer, direction"
            ),
            params,
        )?;
        let mut order: Vec<String> = Vec::new();
        let mut nodes: HashMap<String, serde_json::Map<String, Value>> = HashMap::new();
        let mut aliases: HashMap<String, BTreeSet<String>> = HashMap::new();
        let mut totals: HashMap<String, [i64; 4]> = HashMap::new();
        let mut edges: Vec<Value> = Vec::new();
        for row in rows {
            let peer = row["peer"].as_str().unwrap_or("").to_owned();
            if !nodes.contains_key(&peer) {
                order.push(peer.clone());
                nodes.insert(peer.clone(), row.clone());
            }
            if let Some(text) = row["aliases"].as_str().filter(|text| !text.is_empty()) {
                aliases
                    .entry(peer.clone())
                    .or_default()
                    .extend(text.split(',').map(str::to_owned));
            } else {
                aliases.entry(peer.clone()).or_default();
            }
            let total = totals.entry(peer.clone()).or_insert([0; 4]);
            if row["direction"] == "out" {
                // A worker taking tasks is not a call to the broker: its queue wait stays on the edge.
                total[0] += int(&row, "calls");
                total[1] += int(&row, "total");
                total[2] += int(&row, "errors");
            }
            total[3] = total[3].max(int(&row, "last_seen"));
            edges.push(serde_json::json!({
                "service": row["service"],
                "role": row["role"],
                "peer": peer,
                "direction": row["direction"],
                "traces": int(&row, "traces"),
                "calls": int(&row, "calls"),
                "total": int(&row, "total"),
                "errors": int(&row, "errors"),
            }));
        }
        let mut services: Vec<(String, i64, Value)> = order
            .into_iter()
            .map(|peer| {
                let row = &nodes[&peer];
                let total = totals[&peer];
                let node = serde_json::json!({
                    "kind": row["kind"],
                    "system": row["system"],
                    "address": row["address"],
                    "port": row["port"],
                    "namespace": row["namespace"],
                    "id": peer,
                    "aliases": aliases[&peer].iter().collect::<Vec<_>>(),
                    "calls": total[0],
                    "total": total[1],
                    "errors": total[2],
                    "last_seen": total[3],
                });
                (
                    row["kind"].as_str().unwrap_or("").to_owned(),
                    total[1],
                    node,
                )
            })
            .collect();
        // Stable sorts, as Python's sorted().
        services.sort_by(|a, b| a.0.cmp(&b.0).then(b.1.cmp(&a.1)));
        edges.sort_by_key(|edge| -edge["total"].as_i64().unwrap_or(0));
        Ok(serde_json::json!({
            "apps": self.list_apps(&db, query)?,
            "links": self.list_app_links(&db, query)?,
            "services": services.into_iter().map(|(_, _, node)| node).collect::<Vec<_>>(),
            "edges": edges,
        }))
    }

    /// The project's own web, workers and commands, as services of their own: what they handled and what runs them.
    /// One app's calls to another (`called_by` links): from which role to which, through which server the caller saw
    /// (its HTTP host, its RPC service), how many traces, their time and failures on the called side. The page's
    /// search picks the calling traces.
    fn list_app_links(&self, db: &Connection, query: &str) -> Result<Vec<Value>, ReadError> {
        let (condition, params) = search::compile_where(query, &APP_SEARCH)?;
        let role = |table: &str| SERVICE_ROLE.replace("attrs", &format!("{table}.attrs"));
        let rows = objects(
            db,
            &format!(
                "SELECT caller.service AS service, {caller_role} AS role, callee.service AS to_service, \
                 {callee_role} AS to_role, w3c.peer AS peer, COUNT(*) AS traces, SUM(callee.duration) AS total, \
                 SUM(callee.status = 'error') AS errors \
                 FROM links JOIN traces callee ON callee.id = links.trace_id \
                 JOIN traces caller ON caller.id = links.linked_trace \
                 LEFT JOIN w3c ON w3c.trace_id = links.linked_trace AND w3c.span_id = links.linked_span \
                 AND w3c.side = 'out' \
                 WHERE links.kind = 'called_by' AND links.linked_trace IN (SELECT id FROM traces WHERE {condition}) \
                 GROUP BY 1, 2, 3, 4, 5 ORDER BY traces DESC",
                caller_role = role("caller"),
                callee_role = role("callee"),
            ),
            params,
        )?;
        Ok(rows
            .into_iter()
            .map(|row| {
                serde_json::json!({
                    "service": row["service"],
                    "role": row["role"],
                    "to_service": row["to_service"],
                    "to_role": row["to_role"],
                    "peer": row["peer"],
                    "traces": int(&row, "traces"),
                    "total": int(&row, "total"),
                    "errors": int(&row, "errors"),
                })
            })
            .collect())
    }

    fn list_apps(&self, db: &Connection, query: &str) -> Result<Vec<Value>, ReadError> {
        let (condition, params) = search::compile_where(query, &APP_SEARCH)?;
        let rows = objects(
            db,
            &format!(
                "SELECT service, {SERVICE_ROLE} AS role, COUNT(*) AS traces, \
                 SUM(status = 'error') AS errors, SUM(duration) AS total, MAX(start) AS last_seen, \
                 MAX({LANGUAGE}) AS language, \
                 MAX(json_extract(attrs, '$.\"process.runtime.name\"')) AS runtime_name, \
                 MAX(json_extract(attrs, '$.\"process.runtime.version\"')) AS version, \
                 MAX(json_extract(attrs, '$.\"tracepanel.framework\"')) AS framework \
                 FROM traces WHERE {condition} GROUP BY service, role ORDER BY service, role"
            ),
            params,
        )?;
        Ok(rows
            .into_iter()
            .map(|row| {
                let text = |key: &str| row[key].as_str().map(str::to_owned);
                serde_json::json!({
                    "service": text("service").unwrap_or_default(),
                    "role": text("role").unwrap_or_default(),
                    "traces": int(&row, "traces"),
                    "errors": int(&row, "errors"),
                    "total": int(&row, "total"),
                    "last_seen": int(&row, "last_seen"),
                    "runtime": runtime_label(
                        language_name(text("language"), text("runtime_name")),
                        text("version"),
                        text("framework"),
                    ),
                })
            })
            .collect())
    }

    pub fn clear(&self) -> Result<i64, ReadError> {
        let db = self.connect()?;
        let count: i64 = db.query_row("SELECT COUNT(*) FROM traces", [], |row| row.get(0))?;
        let fts = db.query_row(
            "SELECT count(*) FROM sqlite_master WHERE name = 'logs_fts'",
            [],
            |row| row.get::<_, i64>(0),
        )? > 0;
        let tx = db.unchecked_transaction()?;
        for table in TABLES {
            if table == "meta" || (table == "logs_fts" && !fts) {
                continue;
            }
            tx.execute(&format!("DELETE FROM {table}"), [])?;
        }
        tx.commit()?;
        Ok(count)
    }

    pub fn search_logs(
        &self,
        query: &str,
        limit: i64,
        before: Option<i64>,
    ) -> Result<Page, ReadError> {
        let db = self.connect()?;
        let fts = db.query_row(
            "SELECT count(*) FROM sqlite_master WHERE name = 'logs_fts'",
            [],
            |row| row.get::<_, i64>(0),
        )? > 0;
        let (mut condition, mut params) = search::compile_where(query, &log_search(fts))?;
        if let Some(before) = before {
            condition.push_str(" AND logs.time < ?");
            params.push(Sql::Integer(before));
        }
        params.push(Sql::Integer(limit + 1));
        let mut rows = objects(
            &db,
            &format!(
                "SELECT logs.id, logs.trace_id, logs.time, logs.level, logs.logger, logs.message, logs.exception, \
                 logs.attrs, traces.kind AS trace_kind, traces.htmx AS trace_htmx, traces.name AS trace_name, \
                 traces.method, traces.path, traces.http_status, traces.user_id, traces.service \
                 FROM logs JOIN traces ON traces.id = logs.trace_id WHERE {condition} \
                 ORDER BY logs.time DESC, logs.id DESC LIMIT ?"
            ),
            params,
        )?;
        let more = rows.len() as i64 > limit;
        rows.truncate(limit as usize);
        let items: Vec<Value> = rows
            .into_iter()
            .map(|mut row| {
                let attrs = row
                    .get("attrs")
                    .and_then(Value::as_str)
                    .and_then(|text| serde_json::from_str(text).ok());
                row.insert(
                    "attrs".into(),
                    attrs.unwrap_or(Value::Object(serde_json::Map::new())),
                );
                Value::Object(row)
            })
            .collect();
        let next = if more {
            items.last().and_then(|item| item["time"].as_i64())
        } else {
            None
        };
        Ok(Page { items, next })
    }

    /// Calls to every system (or one, `system:` in the query) aggregated per key, heaviest first: the fields
    /// every list has, what names the group (system, family, target, op, template, name), and the extras some
    /// systems have (statement and vendor for SQL, hits and misses for a cache, via for Redis), null elsewhere.
    pub fn list_calls(&self, query: &str, limit: i64) -> Result<Vec<Value>, ReadError> {
        let db = self.connect()?;
        let rows = aggregate(&db, query, limit)?;
        Ok(objects_of(rows))
    }

    /// The calls matching `query` (one system's, with `system:` in it) at a glance: how many, in how many traces,
    /// the most in one trace, how many failed, their total and p95 time, and a cache's hits and misses (null for
    /// other systems). Over every call, not the top groups a list shows.
    pub fn calls_summary(&self, query: &str) -> Result<Value, ReadError> {
        let (condition, params) = search::compile_where(query, &CALLS_SEARCH)?;
        let db = self.connect()?;
        let mut totals = objects(
            &db,
            &format!(
                "SELECT COUNT(*) AS calls, COUNT(DISTINCT trace_id) AS traces, COALESCE(SUM(error), 0) AS errors, \
                 COALESCE(SUM(duration), 0) AS total, \
                 CASE WHEN MAX(family) = 'cache' THEN COALESCE(SUM(hit = 1), 0) END AS hits, \
                 CASE WHEN MAX(family) = 'cache' THEN COALESCE(SUM(hit = 0), 0) END AS misses \
                 FROM calls WHERE {condition}"
            ),
            params.clone(),
        )?
        .pop()
        .unwrap_or_default();
        let calls = totals.get("calls").and_then(Value::as_i64).unwrap_or(0);
        // One number, or null (no calls).
        let one = |sql: &str, params: Vec<Sql>| -> Result<Value, ReadError> {
            Ok(db
                .query_row(sql, rusqlite::params_from_iter(params), |row| {
                    row.get::<_, Option<i64>>(0)
                })?
                .map_or(Value::Null, Value::from))
        };
        let most_per_trace = one(
            &format!(
                "SELECT MAX(n) FROM (SELECT COUNT(*) AS n FROM calls WHERE {condition} GROUP BY trace_id)"
            ),
            params.clone(),
        )?;
        // The call 95% of the others are no slower than: nearest rank.
        let p95 = if calls == 0 {
            Value::Null
        } else {
            let mut ranked = params;
            ranked.push(Sql::Integer((calls * 95 + 99) / 100 - 1));
            one(
                &format!(
                    "SELECT duration FROM calls WHERE {condition} ORDER BY duration LIMIT 1 OFFSET ?"
                ),
                ranked,
            )?
        };
        totals.insert("most_per_trace".into(), most_per_trace);
        totals.insert("p95".into(), p95);
        Ok(Value::Object(totals))
    }

    /// Newest first; `before` is the `start` of the last row of the previous page.
    pub fn search_traces(
        &self,
        query: &str,
        limit: i64,
        before: Option<i64>,
    ) -> Result<Page, ReadError> {
        let (mut condition, mut params) = search::compile_where(query, &TRACE_SEARCH)?;
        if let Some(before) = before {
            condition.push_str(" AND start < ?");
            params.push(Sql::Integer(before));
        }
        params.push(Sql::Integer(limit + 1));
        let db = self.connect()?;
        let mut statement = db.prepare(&format!(
            "SELECT {LISTING} FROM traces WHERE {condition} ORDER BY start DESC LIMIT ?"
        ))?;
        let mut items: Vec<Value> = statement
            .query_map(rusqlite::params_from_iter(params), trace_row)?
            .collect::<Result<_, _>>()?;
        let more = items.len() as i64 > limit;
        items.truncate(limit as usize);
        let next = if more {
            items.last().and_then(|item| item["start"].as_i64())
        } else {
            None
        };
        Ok(Page { items, next })
    }

    pub fn new(path: &Path) -> Self {
        Self {
            path: path.to_owned(),
        }
    }

    pub(crate) fn connect(&self) -> rusqlite::Result<Connection> {
        let db = Connection::open(&self.path)?;
        db.busy_timeout(std::time::Duration::from_secs(5))?;
        Ok(db)
    }

    /// Traces by id (the panel's tab history) or the latest ones.
    pub fn list_traces(&self, ids: &[String], limit: i64) -> rusqlite::Result<Vec<Value>> {
        let db = self.connect()?;
        let mut params: Vec<Sql> = ids.iter().map(|id| Sql::Text(id.clone())).collect();
        let condition = if ids.is_empty() {
            "1 = 1".to_owned()
        } else {
            format!("id IN ({})", vec!["?"; ids.len()].join(", "))
        };
        params.push(Sql::Integer(limit));
        let mut statement = db.prepare(&format!(
            "SELECT {LISTING} FROM traces WHERE {condition} ORDER BY start DESC LIMIT ?"
        ))?;
        let rows = statement.query_map(rusqlite::params_from_iter(params), trace_row)?;
        rows.collect()
    }

    /// The trace's document, as stored.
    /// A trace to share, with what is linked to it (the request that queued it, the tasks it queued, the traces it
    /// called and was called by, its WebSocket connection), each with its own links: everything the trace page shows,
    /// and nothing else of the store. Without `values`, what stays local goes (`tracepanel_protocol::local`).
    /// None when the trace isn't stored.
    pub fn snapshot(&self, id: &str, values: bool) -> rusqlite::Result<Option<Value>> {
        let Some(root) = self.get_trace(id)? else {
            return Ok(None);
        };
        let mut order = vec![id.to_owned()];
        let mut docs = serde_json::Map::new();
        let mut related = serde_json::Map::new();
        docs.insert(id.to_owned(), document(&root, values));
        let links = self.related(id)?;
        for linked in linked_ids(&links) {
            if order.len() >= SNAPSHOT_TRACES || order.contains(&linked) {
                continue;
            }
            if let Some(doc) = self.get_trace(&linked)? {
                docs.insert(linked.clone(), document(&doc, values));
                order.push(linked);
            }
        }
        related.insert(id.to_owned(), links);
        for linked in &order[1..] {
            related.insert(linked.clone(), self.related(linked)?);
        }
        Ok(Some(serde_json::json!({
            "format": SNAPSHOT_FORMAT,
            "agent": env!("CARGO_PKG_VERSION"),
            "created": search::now_us(),
            "values": values,
            "root": id,
            "traces": docs,
            "related": related,
        })))
    }

    pub fn get_trace(&self, id: &str) -> rusqlite::Result<Option<String>> {
        let db = self.connect()?;
        let mut statement = db.prepare("SELECT doc FROM traces WHERE id = ?1")?;
        let mut rows = statement.query([id])?;
        rows.next()?.map(|row| row.get(0)).transpose()
    }

    /// Traces linked to this one, by link kind: tasks (enqueued_by), WebSocket connections and layer messages.
    pub fn related(&self, id: &str) -> rusqlite::Result<Value> {
        let db = self.connect()?;
        let mut statement =
            db.prepare("SELECT kind, linked_trace, linked_span, trace_id FROM links WHERE trace_id = ?1 OR linked_trace = ?1")?;
        let links: Vec<(String, String, String, String)> = statement
            .query_map([id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })?
            .collect::<Result<_, _>>()?;
        let mut parents: HashMap<String, Vec<String>> = HashMap::new();
        let mut children: HashMap<String, Vec<String>> = HashMap::new();
        // Which span of this trace each linked trace came from: the call tree shows a task under its enqueue.
        let mut via = serde_json::Map::new();
        for (kind, linked, span, owner) in links {
            if owner == id {
                parents.entry(kind).or_default().push(linked);
            } else {
                children.entry(kind).or_default().push(owner.clone());
                via.insert(owner, Value::from(span));
            }
        }
        let one = |kind: &str| -> rusqlite::Result<Value> {
            match parents.get(kind) {
                Some(ids) => Ok(self
                    .list_traces(ids, 100)?
                    .into_iter()
                    .next()
                    .unwrap_or(Value::Null)),
                None => Ok(Value::Null),
            }
        };
        let many = |kind: &str| -> rusqlite::Result<Value> {
            let mut found = match children.get(kind) {
                Some(ids) => self.list_traces(ids, RELATED_LIMIT)?,
                None => Vec::new(),
            };
            found.sort_by_key(|item| item["start"].as_i64().unwrap_or_default());
            Ok(Value::Array(found))
        };
        Ok(serde_json::json!({
            "enqueued_by": one("enqueued_by")?,
            "enqueued": many("enqueued_by")?,
            "connection": one("connection")?,
            "connection_events": many("connection")?,
            "sent_by": one("sent_by")?,
            "delivered": many("sent_by")?,
            "called_by": one("called_by")?,
            "calls": many("called_by")?,
            "via": via,
        }))
    }

    /// Issue groups (and how many are errors) and traces per entry point: what the console's menu shows.
    /// The sidebar's numbers; with `service`, only what that app (service.name) recorded.
    pub fn counts(&self, service: Option<&str>) -> rusqlite::Result<Value> {
        let db = self.connect()?;
        // NULL: every app.
        let service = service.filter(|name| !name.is_empty());
        let grouped = |sql: &str| -> rusqlite::Result<HashMap<String, i64>> {
            let mut statement = db.prepare(sql)?;
            let rows = statement.query_map([service], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })?;
            rows.collect()
        };
        let kinds = grouped(
            "SELECT kind, COUNT(*) FROM issues WHERE ?1 IS NULL OR fingerprint IN \
             (SELECT issue_traces.fingerprint FROM issue_traces JOIN traces ON traces.id = issue_traces.trace_id \
             WHERE traces.service = ?1) GROUP BY kind",
        )?;
        let traces = grouped(
            "SELECT kind, COUNT(*) FROM traces WHERE ?1 IS NULL OR service = ?1 GROUP BY kind",
        )?;
        // A GraphQL request is named after its operation: the name says it, no JSON to parse.
        let graphql: i64 = db.query_row(
            "SELECT COUNT(*) FROM traces WHERE kind = 'http' AND name LIKE 'GraphQL %' \
             AND (?1 IS NULL OR service = ?1)",
            [service],
            |row| row.get(0),
        )?;
        // The systems with operations (of the app's traces), each with its family: the console lists a page for
        // each, in the families' order, then by name.
        let mut systems: Vec<(String, String)> = {
            let mut statement = db.prepare(
                "SELECT DISTINCT system, family FROM calls WHERE ?1 IS NULL OR trace_id IN \
                 (SELECT id FROM traces WHERE service = ?1)",
            )?;
            let rows = statement.query_map([service], |row| Ok((row.get(0)?, row.get(1)?)))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        let rank = |family: &str| {
            tracepanel_analysis::calls::FAMILIES
                .iter()
                .position(|known| *known == family)
                .unwrap_or(usize::MAX)
        };
        systems.sort_by(|(a, af), (b, bf)| rank(af).cmp(&rank(bf)).then_with(|| a.cmp(b)));
        let count = |map: &HashMap<String, i64>, key: &str| map.get(key).copied().unwrap_or(0);
        let errors = count(&kinds, "error");
        Ok(serde_json::json!({
            // Two lists in the console: what failed, and what could be better.
            "issues": kinds.values().sum::<i64>() - errors,
            "errors": errors,
            "sections": {
                "http": count(&traces, "http") - graphql,
                "graphql": graphql,
                "tasks": count(&traces, "task"),
                "websockets": count(&traces, "websocket"),
                "jobs": count(&traces, "command"),
                "rpc": count(&traces, "rpc"),
                "pages": count(&traces, "page"),
                "systems": systems
                    .iter()
                    .map(|(system, family)| {
                        serde_json::json!({
                            "system": system,
                            "family": family,
                            "label": tracepanel_analysis::calls::display_name(system),
                        })
                    })
                    .collect::<Vec<_>>(),
            },
        }))
    }
}

/// One column of each system's operations, its distinct values for the console's filters: the targets (databases,
/// instances, hosts, topics) or the operations (SELECT, GET, find, publish).
fn by_system(
    db: &Connection,
    column: &str,
    of_trace: &str,
    service: &str,
) -> rusqlite::Result<Value> {
    let mut statement = db.prepare(&format!(
        "SELECT DISTINCT system, {column} FROM calls WHERE {column} != '' AND {of_trace} ORDER BY 1, 2"
    ))?;
    let params: Vec<&dyn rusqlite::ToSql> = if statement.parameter_count() == 0 {
        vec![]
    } else {
        vec![&service]
    };
    let mut by_system = serde_json::Map::new();
    let rows = statement.query_map(params.as_slice(), |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    for row in rows {
        let (system, target) = row?;
        by_system
            .entry(system)
            .or_insert_with(|| Value::Array(Vec::new()))
            .as_array_mut()
            .expect("an array")
            .push(Value::from(target));
    }
    Ok(Value::Object(by_system))
}

/// The language as the panel names it: OpenTelemetry's `nodejs` is Node, or Bun when Bun runs it; `webjs`, a page
/// recorded in the browser, is the browser.
fn language_name(language: Option<String>, runtime: Option<String>) -> Option<String> {
    match (language.as_deref(), runtime.as_deref()) {
        (Some("webjs"), _) => Some("Browser".into()),
        (Some("nodejs" | "js" | "webjs"), Some("bun")) => Some("Bun".into()),
        (Some("nodejs"), _) => Some("Node".into()),
        _ => language,
    }
}

/// What runs an app, as the SDKs label it for the panel: "Python 3.12 · Django 6.0", "Go 1.27".
fn runtime_label(
    language: Option<String>,
    version: Option<String>,
    framework: Option<String>,
) -> Option<String> {
    let language = language?;
    let mut name = language.chars();
    let language = name
        .next()
        .map(|first| first.to_uppercase().chain(name).collect::<String>())?;
    let short = |text: &str| text.split('.').take(2).collect::<Vec<_>>().join(".");
    let runtime = match version {
        Some(version) => format!("{language} {}", short(&version)),
        None => language,
    };
    Some(match framework {
        Some(framework) => {
            let (name, version) = framework.split_once(' ').unwrap_or((&framework, ""));
            let framework = if version.is_empty() {
                name.to_owned()
            } else {
                format!("{name} {}", short(version))
            };
            format!("{runtime} · {framework}")
        }
        None => runtime,
    })
}

/// The version of a snapshot's layout: a file made now opens in a later console.
const SNAPSHOT_FORMAT: i64 = 1;
/// A trace and at most this many linked to it, the trace itself included.
const SNAPSHOT_TRACES: usize = 100;

/// A stored document as a snapshot carries it: as it is, or without what stays local.
fn document(doc: &str, values: bool) -> Value {
    let mut value: Value = serde_json::from_str(doc).unwrap_or(Value::Null);
    if !values {
        tracepanel_protocol::local::strip(&mut value);
    }
    value
}

/// The ids of the traces a trace's links name, in the order the trace page lists them.
fn linked_ids(related: &Value) -> Vec<String> {
    let mut ids = Vec::new();
    for key in [
        "enqueued_by",
        "called_by",
        "sent_by",
        "connection",
        "enqueued",
        "calls",
        "delivered",
        "connection_events",
    ] {
        let found: Vec<&Value> = match &related[key] {
            Value::Array(items) => items.iter().collect(),
            Value::Object(_) => vec![&related[key]],
            _ => Vec::new(),
        };
        ids.extend(
            found
                .into_iter()
                .filter_map(|item| item["id"].as_str().map(str::to_owned)),
        );
    }
    ids
}

#[cfg(test)]
mod tests {
    use super::{language_name, runtime_label};

    fn label(
        language: Option<&str>,
        version: Option<&str>,
        framework: Option<&str>,
    ) -> Option<String> {
        runtime_label(
            language.map(str::to_owned),
            version.map(str::to_owned),
            framework.map(str::to_owned),
        )
    }

    #[test]
    fn an_app_is_labelled_as_its_sdk_labels_it() {
        assert_eq!(
            label(Some("python"), Some("3.12.4"), Some("Django 6.0.1")).as_deref(),
            Some("Python 3.12 · Django 6.0")
        );
        assert_eq!(
            label(Some("python"), Some("3.14.0"), None).as_deref(),
            Some("Python 3.14")
        );
        assert_eq!(
            label(Some("go"), Some("1.27.1"), None).as_deref(),
            Some("Go 1.27")
        );
        assert_eq!(
            label(Some("python"), None, Some("Flask")).as_deref(),
            Some("Python · Flask")
        );
        assert_eq!(label(None, Some("3.12.4"), Some("Django 6.0.1")), None);
    }

    #[test]
    fn a_node_or_bun_app_is_labelled_by_its_runtime() {
        let node = language_name(Some("nodejs".into()), Some("node".into()));
        let bun = language_name(Some("nodejs".into()), Some("bun".into()));

        assert_eq!(
            label(node.as_deref(), Some("26.11.1"), Some("Next.js 16.4.0")).as_deref(),
            Some("Node 26.11 · Next.js 16.4")
        );
        assert_eq!(
            label(bun.as_deref(), Some("1.3.4"), Some("Bun.serve")).as_deref(),
            Some("Bun 1.3 · Bun.serve")
        );
        let browser = language_name(Some("webjs".into()), None);
        assert_eq!(
            label(browser.as_deref(), None, None).as_deref(),
            Some("Browser")
        );
    }
}
