//! Reading for the console: the reader, row helpers, one trace and its relations, lists with cursors, logs, queries, emails, issues, services, counts.

use super::*;
use rusqlite::OptionalExtension;

/// How many of an issue's traces the store still holds: what can be opened of the occurrences it counts.
const STORED: &str =
    "(SELECT count(*) FROM issue_traces t WHERE t.fingerprint = issues.fingerprint) AS stored";

/// The columns a trace has in lists.
pub(crate) const LISTING: &str = "id, kind, name, start, duration, status, http_status, method, path, route, view, user_id, \
    queries, db_time, issues, issue_kinds, errors, logs, mails, db_aliases, cache_aliases, task_state, htmx, service";
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

/// The window a log series spans: [start, end] as asked or as the records lie; without a start asked for, at least
/// ten minutes up to the end, so a burst of records still has a span to stand in.
fn log_window(start: Option<i64>, end: Option<i64>, asked: bool) -> Option<(i64, i64)> {
    const MIN_WINDOW_US: i64 = 10 * 60 * 1_000_000;
    let (start, end) = (start?, end?);
    if end < start {
        return None;
    }
    Some((
        if asked {
            start
        } else {
            start.min(end - MIN_WINDOW_US)
        },
        end,
    ))
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
/// a cache's `hits` and `misses` (null for the others), an LLM call's `tokens_in`, `tokens_out`, estimated `cost` and
/// `p95` (null for the others), `origin` (the most common line of code) and the latest call (`sample_trace`,
/// `sample_span`), which the console opens.
///
/// With `duration` in the search a group is only its calls that slow: its numbers, its latest call and its line of
/// code are theirs, and `all_calls` says how many it has without it (null without `duration`).
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
    let filters = params.clone();
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
    let slower = Slower::of(query)?;
    // The latest call of each group: the console opens it (and explains it, for SQL), and it names the group.
    let latest: Vec<Sql> = objects(
        db,
        &format!(
            "SELECT rowid AS id, MAX(start) FROM calls WHERE key IN ({marks}){} GROUP BY key",
            slower.clause
        ),
        slower.params(&keys),
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
             WHERE key IN ({marks}) AND origin IS NOT NULL{} GROUP BY key, origin",
            slower.clause
        ),
        slower.params(&keys),
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
    let mut all = slower.all_calls(db, &keys)?;
    let rows: Vec<serde_json::Map<String, Value>> = rows
        .into_iter()
        .map(|mut row| {
            let group = text_of(&row);
            row.insert(
                "all_calls".into(),
                all.as_mut().map_or(Value::Null, |all| {
                    Value::from(all.remove(&group).unwrap_or(0))
                }),
            );
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
        .collect();
    with_llm_usage(db, &condition, filters, rows)
}

/// A search's `duration` filters, for a list of calls' groups: what keeps a group's slow calls alone, and the search
/// without them, which counts each group's calls whatever their time.
struct Slower {
    /// ` AND (…)` on the calls table, empty without `duration`.
    clause: String,
    filters: Vec<Sql>,
    /// The search without `duration`: None without it.
    rest: Option<String>,
}

impl Slower {
    fn of(query: &str) -> Result<Self, ReadError> {
        let (rest, those) = search::split_off(query, "duration");
        if those.is_empty() {
            return Ok(Self {
                clause: String::new(),
                filters: Vec::new(),
                rest: None,
            });
        }
        let (condition, filters) = search::compile_where(&those, &CALLS_SEARCH)?;
        Ok(Self {
            clause: format!(" AND ({condition})"),
            filters,
            rest: Some(rest),
        })
    }

    /// The groups' keys, then the filters' values: the parameters of a query on them with `clause` after them.
    fn params(&self, keys: &[Sql]) -> Vec<Sql> {
        keys.iter()
            .cloned()
            .chain(self.filters.iter().cloned())
            .collect()
    }

    /// How many calls each group has without `duration` (the rest of the search still holds), from the group index.
    fn all_calls(
        &self,
        db: &Connection,
        keys: &[Sql],
    ) -> Result<Option<HashMap<String, i64>>, ReadError> {
        let Some(rest) = &self.rest else {
            return Ok(None);
        };
        let (condition, filters) = search::compile_where(rest, &CALLS_SEARCH)?;
        let params = keys.iter().cloned().chain(filters).collect();
        let counts = objects(
            db,
            &format!(
                "SELECT key, COUNT(*) AS n FROM calls INDEXED BY calls_group \
                 WHERE key IN ({}) AND ({condition}) GROUP BY key",
                marks(keys.len())
            ),
            params,
        )?;
        Ok(Some(
            counts
                .into_iter()
                .map(|row| {
                    (
                        row["key"].as_str().unwrap_or("").to_owned(),
                        row["n"].as_i64().unwrap_or(0),
                    )
                })
                .collect(),
        ))
    }
}

const LLM_FIELDS: [&str; 4] = ["tokens_in", "tokens_out", "cost", "p95"];

/// An LLM call's group gets its tokens, its estimated cost (null when no call of it had a price) and its p95, with
/// the list's filters; every other group nulls. LLM calls are few, and a page of them is about their time: their
/// durations are read whole, which a page of SQL couldn't afford.
fn with_llm_usage(
    db: &Connection,
    condition: &str,
    filters: Vec<Sql>,
    mut rows: Vec<serde_json::Map<String, Value>>,
) -> Result<Vec<serde_json::Map<String, Value>>, ReadError> {
    let keys: Vec<Sql> = rows
        .iter()
        .filter(|row| row.get("family").and_then(Value::as_str) == Some("llm"))
        .map(|row| Sql::Text(row["key"].as_str().unwrap_or("").to_owned()))
        .collect();
    let mut found: HashMap<String, serde_json::Map<String, Value>> = HashMap::new();
    if !keys.is_empty() {
        let mut params = filters;
        params.extend(keys.iter().cloned());
        let marks = marks(keys.len());
        for row in objects(
            db,
            &format!(
                "SELECT key, SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out, ROUND(SUM(cost), 10) AS cost, \
                 json_group_array(duration) AS durations FROM calls \
                 WHERE ({condition}) AND key IN ({marks}) GROUP BY key"
            ),
            params,
        )? {
            let mut durations: Vec<i64> = row
                .get("durations")
                .and_then(Value::as_str)
                .and_then(|text| serde_json::from_str(text).ok())
                .unwrap_or_default();
            durations.sort_unstable();
            let mut usage = row.clone();
            usage.remove("durations");
            // Nearest rank, as a system's summary has it.
            let p95 = (!durations.is_empty())
                .then(|| durations[(durations.len() * 95).div_ceil(100) - 1]);
            usage.insert("p95".into(), p95.map_or(Value::Null, Value::from));
            found.insert(row["key"].as_str().unwrap_or("").to_owned(), usage);
        }
    }
    for row in &mut rows {
        let usage = found.remove(row["key"].as_str().unwrap_or(""));
        for field in LLM_FIELDS {
            let value = usage
                .as_ref()
                .and_then(|usage| usage.get(field))
                .cloned()
                .unwrap_or(Value::Null);
            row.insert(field.into(), value);
        }
    }
    Ok(rows)
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
            // The routes whose requests logged anything: what the logs' Route menu offers.
            "log_route": distinct(&format!(
                "SELECT DISTINCT route FROM traces WHERE route != '' AND {traces} AND id IN (SELECT trace_id FROM logs) \
                 ORDER BY 1"
            ))?,
            "apps": apps_by_page(&db, service)?,
            "db": distinct(&format!("SELECT DISTINCT target FROM calls WHERE system = 'sql' AND {of_trace} ORDER BY 1"))?,
            "targets": by_system(&db, "target", of_trace, service)?,
            "ops": by_system(&db, "op", of_trace, service)?,
            "task": distinct(&format!("SELECT DISTINCT name FROM traces WHERE kind = 'task' AND {traces} ORDER BY 1"))?,
            "job": distinct(&format!("SELECT DISTINCT name FROM traces WHERE kind = 'command' AND {traces} ORDER BY 1"))?,
            "rpc": distinct(&format!("SELECT DISTINCT name FROM traces WHERE kind = 'rpc' AND {traces} ORDER BY 1"))?,
            "page": distinct(&format!("SELECT DISTINCT name FROM traces WHERE kind = 'page' AND {traces} ORDER BY 1"))?,
            // What ran the tasks: celery, rq, django, spring (@Async), rabbitmq, kafka (a listener's deliveries).
            "task_system": distinct(&format!(
                "SELECT DISTINCT {SYSTEM} FROM traces WHERE kind = 'task' AND {SYSTEM} IS NOT NULL AND {traces} ORDER BY 1"
            ))?,
            "queue": distinct(&format!(
                "SELECT DISTINCT {QUEUE} FROM traces WHERE kind = 'task' AND {QUEUE} IS NOT NULL AND {traces} ORDER BY 1"
            ))?,
            // What records were logged inside: the kinds and systems of spans, and the spans by name.
            "in": distinct(&format!(
                "SELECT value FROM (SELECT json_extract(span.value, '$.kind') AS value FROM logs, json_each(logs.spans) \
                 AS span WHERE {of_trace} UNION SELECT json_extract(span.value, '$.system') FROM logs, \
                 json_each(logs.spans) AS span WHERE {of_trace}) ORDER BY 1"
            ))?,
            // Spans by name, for span: in traces and in logs: the spans table, without the calls (they have call:,
            // db: and the rest).
            "span": distinct(&format!("SELECT DISTINCT name FROM spans WHERE {of_trace} ORDER BY 1 LIMIT 500"))?,
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
            &format!(
                "SELECT *, {STORED} FROM issues WHERE {condition} ORDER BY last_seen DESC LIMIT ?"
            ),
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
            &format!("SELECT *, {STORED} FROM issues WHERE fingerprint = ?"),
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
                 MAX(cloud_service) AS cloud_service, MAX(cloud_region) AS cloud_region, \
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
        // Rows stored under a trace's kind ("http", with no role from its SDK) read as that kind's role ("web").
        let mut mapped = false;
        for row in rows {
            let peer = row["peer"].as_str().unwrap_or("").to_owned();
            if !nodes.contains_key(&peer) {
                order.push(peer.clone());
                nodes.insert(peer.clone(), row.clone());
            }
            // A layer's peer is on AWS when any of its calls reached AWS.
            if let Some(node) = nodes.get_mut(&peer)
                && node["cloud_service"].is_null()
                && !row["cloud_service"].is_null()
            {
                node.insert("cloud_service".into(), row["cloud_service"].clone());
                node.insert("cloud_region".into(), row["cloud_region"].clone());
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
            let stored = row["role"].as_str().unwrap_or("");
            let role = peer_role(stored);
            mapped |= role != stored;
            edges.push(serde_json::json!({
                "service": row["service"],
                "role": role,
                "peer": peer,
                "direction": row["direction"],
                "traces": int(&row, "traces"),
                "calls": int(&row, "calls"),
                "total": int(&row, "total"),
                "errors": int(&row, "errors"),
            }));
        }
        if mapped {
            edges = merged_edges(edges);
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
                    "cloud": cloud(row),
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
    /// (its HTTP host, its RPC service; the call the callee names, as a database span carries several), how many traces, their time and failures on the called side. The page's
    /// search picks the calling traces.
    fn list_app_links(&self, db: &Connection, query: &str) -> Result<Vec<Value>, ReadError> {
        let (condition, params) = search::compile_where(query, &APP_SEARCH)?;
        let role = app_role;
        let rows = objects(
            db,
            &format!(
                "SELECT caller.service AS service, {caller_role} AS role, callee.service AS to_service, \
                 {callee_role} AS to_role, w3c.peer AS peer, COUNT(*) AS traces, SUM(callee.duration) AS total, \
                 SUM(callee.status = 'error') AS errors, GROUP_CONCAT(callee.duration) AS durations \
                 FROM links JOIN traces callee ON callee.id = links.trace_id \
                 JOIN traces caller ON caller.id = links.linked_trace \
                 LEFT JOIN w3c inbound ON inbound.trace_id = links.trace_id AND inbound.side = 'in' \
                 LEFT JOIN w3c ON w3c.w3c_trace = inbound.w3c_trace AND w3c.w3c_span = inbound.w3c_span \
                 AND w3c.trace_id = links.linked_trace AND w3c.side = 'out' \
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
                let mut durations = numbers(&row, "durations");
                durations.sort_unstable();
                serde_json::json!({
                    "service": row["service"],
                    "role": row["role"],
                    "to_service": row["to_service"],
                    "to_role": row["to_role"],
                    "peer": row["peer"],
                    "traces": int(&row, "traces"),
                    "total": int(&row, "total"),
                    "errors": int(&row, "errors"),
                    "p50": pct(&durations, 0.5),
                    "p95": pct(&durations, 0.95),
                })
            })
            .collect())
    }

    fn list_apps(&self, db: &Connection, query: &str) -> Result<Vec<Value>, ReadError> {
        let (condition, params) = search::compile_where(query, &APP_SEARCH)?;
        let rows = objects(
            db,
            &format!(
                // What runs the app, from its latest trace: MAX(start) is the one min/max aggregate, so SQLite takes
                // the bare column, its attributes, from that row, read below once a group (not a JSON path a row). A
                // largest string would mix versions across an upgrade ("4.9" over "4.10", Java "8.0" over "21.0") and
                // take each part from another trace. By kind too: a trace whose SDK named no role is its kind's
                // role, merged below. The issues' fingerprints are looked up only for a trace that raised any
                // (`issues` counts its findings, `errors` its errors): most traces raise none.
                "SELECT service, {SERVICE_ROLE} AS role, kind, COUNT(*) AS traces, \
                 SUM(status = 'error') AS errors, SUM(duration) AS total, MAX(start) AS last_seen, \
                 attrs AS latest, GROUP_CONCAT(duration) AS durations, \
                 GROUP_CONCAT(DISTINCT CASE WHEN issues > 0 OR errors > 0 THEN \
                 (SELECT GROUP_CONCAT(fingerprint) FROM issue_traces WHERE trace_id = traces.id) END) \
                 AS fingerprints \
                 FROM traces WHERE {condition} GROUP BY service, role, kind"
            ),
            params,
        )?;
        let mut apps: std::collections::BTreeMap<(String, String), App> =
            std::collections::BTreeMap::new();
        for row in rows {
            let text = |key: &str| row[key].as_str().map(str::to_owned);
            let named = text("role").filter(|role| !role.is_empty());
            let role =
                named.unwrap_or_else(|| kind_role(row["kind"].as_str().unwrap_or("")).to_owned());
            let app = apps
                .entry((text("service").unwrap_or_default(), role))
                .or_default();
            app.traces += int(&row, "traces");
            app.errors += int(&row, "errors");
            app.total += int(&row, "total");
            app.durations.extend(numbers(&row, "durations"));
            if let Some(issues) = row["fingerprints"].as_str() {
                app.issues.extend(
                    issues
                        .split(',')
                        .filter(|one| !one.is_empty())
                        .map(str::to_owned),
                );
            }
            let runtime = runtime_of(row["latest"].as_str());
            let last_seen = int(&row, "last_seen");
            // What runs it: its latest trace's that says so.
            if runtime.is_some() && last_seen >= app.runtime_seen {
                app.runtime = runtime;
                app.runtime_seen = last_seen;
            }
            app.last_seen = app.last_seen.max(last_seen);
        }
        Ok(apps
            .into_iter()
            .map(|((service, role), mut app)| {
                app.durations.sort_unstable();
                serde_json::json!({
                    "service": service,
                    "role": role,
                    "traces": app.traces,
                    "errors": app.errors,
                    "total": app.total,
                    "p50": pct(&app.durations, 0.5),
                    "p95": pct(&app.durations, 0.95),
                    "issues": app.issues.len(),
                    "last_seen": app.last_seen,
                    "runtime": app.runtime,
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

    /// How many records matching `query` were logged in each of `buckets` slices of time, by level: the period the
    /// query's since:/until: give, else the records' own (at least ten minutes, up to the last one).
    pub fn log_series(&self, query: &str, buckets: i64) -> Result<Value, ReadError> {
        let db = self.connect()?;
        let fts = db.query_row(
            "SELECT count(*) FROM sqlite_master WHERE name = 'logs_fts'",
            [],
            |row| row.get::<_, i64>(0),
        )? > 0;
        let (condition, params) = search::compile_where(query, &log_search(fts))?;
        let from = format!("FROM logs JOIN traces ON traces.id = logs.trace_id WHERE {condition}");
        let (first, last): (Option<i64>, Option<i64>) = db.query_row(
            &format!("SELECT min(logs.time), max(logs.time) {from}"),
            rusqlite::params_from_iter(params.iter()),
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let (since, until) = search::period(query, search::now_us());
        let Some((start, end)) = log_window(since.or(first), until.or(last), since.is_some())
        else {
            return Ok(serde_json::json!({"series": []}));
        };
        let buckets = buckets.max(1);
        let width = ((end - start) / buckets + 1).max(1);
        let mut counts: Vec<serde_json::Map<String, Value>> =
            vec![serde_json::Map::new(); buckets as usize];
        let mut query_params = vec![Sql::Integer(start), Sql::Integer(width)];
        query_params.extend(params);
        let mut statement = db.prepare(&format!(
            "SELECT (logs.time - ?) / ? AS bucket, logs.level, count(*) {from} GROUP BY bucket, logs.level"
        ))?;
        let rows = statement.query_map(rusqlite::params_from_iter(query_params.iter()), |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?;
        for row in rows {
            let (bucket, level, count) = row?;
            if let Some(levels) = usize::try_from(bucket)
                .ok()
                .and_then(|at| counts.get_mut(at))
            {
                levels.insert(level, Value::from(count));
            }
        }
        let series: Vec<Value> = counts
            .into_iter()
            .enumerate()
            .map(|(index, levels)| {
                let low = start + index as i64 * width;
                let total: i64 = levels.values().filter_map(Value::as_i64).sum();
                serde_json::json!({"start": low, "end": low + width, "count": total, "levels": levels})
            })
            .collect();
        Ok(serde_json::json!({"series": series}))
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
                 logs.attrs, logs.span_id, logs.spans, traces.kind AS trace_kind, traces.htmx AS trace_htmx, traces.name AS trace_name, \
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
                let spans = row
                    .get("spans")
                    .and_then(Value::as_str)
                    .and_then(|text| serde_json::from_str(text).ok());
                row.insert("spans".into(), spans.unwrap_or(Value::Array(vec![])));
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
    /// the most in one trace, how many failed, their total and p95 time, a cache's hits and misses, and an LLM's
    /// tokens in and out and estimated cost (null for other systems). Over every call, not the top groups a list shows.
    pub fn calls_summary(&self, query: &str) -> Result<Value, ReadError> {
        let (condition, params) = search::compile_where(query, &CALLS_SEARCH)?;
        let db = self.connect()?;
        let mut totals = objects(
            &db,
            &format!(
                "SELECT COUNT(*) AS calls, COUNT(DISTINCT trace_id) AS traces, COALESCE(SUM(error), 0) AS errors, \
                 COALESCE(SUM(duration), 0) AS total, \
                 CASE WHEN MAX(family) = 'cache' THEN COALESCE(SUM(hit = 1), 0) END AS hits, \
                 CASE WHEN MAX(family) = 'cache' THEN COALESCE(SUM(hit = 0), 0) END AS misses, \
                 CASE WHEN MAX(family) = 'llm' THEN COALESCE(SUM(tokens_in), 0) END AS tokens_in, \
                 CASE WHEN MAX(family) = 'llm' THEN COALESCE(SUM(tokens_out), 0) END AS tokens_out, \
                 CASE WHEN MAX(family) = 'llm' THEN ROUND(SUM(cost), 10) END AS cost \
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
    /// The trace that served a call another project's app made, by the W3C ids the call carried (its trace and the
    /// span that called): what a neighbouring agent asks this one.
    pub fn served(&self, w3c_trace: &str, w3c_span: &str) -> rusqlite::Result<Option<Value>> {
        let db = self.connect()?;
        let id: Option<String> = db
            .query_row(
                "SELECT trace_id FROM w3c WHERE side = 'in' AND w3c_trace = ?1 AND w3c_span = ?2 LIMIT 1",
                [w3c_trace, w3c_span],
                |row| row.get(0),
            )
            .optional()?;
        Ok(match id {
            Some(id) => self.list_traces(&[id], 1)?.into_iter().next(),
            None => None,
        })
    }

    /// This trace's calls that carried it on to another app no trace here answered: (its W3C trace, the call's W3C
    /// span, the call's span), for the agents of other projects to be asked.
    pub fn unanswered_calls(&self, id: &str) -> rusqlite::Result<Vec<(String, String, String)>> {
        let db = self.connect()?;
        let mut statement = db.prepare(
            "SELECT o.w3c_trace, o.w3c_span, o.span_id FROM w3c o
             WHERE o.trace_id = ?1 AND o.side = 'out' AND o.span_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM w3c i WHERE i.side = 'in' AND i.w3c_trace = o.w3c_trace
                                                     AND i.w3c_span = o.w3c_span)
             LIMIT 20",
        )?;
        let rows = statement.query_map([id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
        rows.collect()
    }

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
    /// called and was called by, its WebSocket connection), each with its own links, and its whole chain of calls (as
    /// `Reader::chain` walks it, other projects' traces from `remote`): everything the trace page shows, and nothing
    /// else of the store. Without `values`, what stays local goes (`tracepanel_protocol::local`). None when the trace
    /// isn't stored.
    pub fn snapshot(
        &self,
        id: &str,
        values: bool,
        remote: Remote,
    ) -> rusqlite::Result<Option<Value>> {
        let Some(chain) = self.chain(id, true, remote)? else {
            return Ok(None);
        };
        // The chain whole (it holds fewer traces than a snapshot), then the trace's other links.
        let mut order = Vec::new();
        let mut docs = serde_json::Map::new();
        let mut related = serde_json::Map::new();
        for member in &chain.members {
            let id = member.id().to_owned();
            docs.insert(
                id.clone(),
                stored(shifted(member.doc.clone(), -member.shift), values),
            );
            // Another project's trace has no links here: it is listed under the call that reached it.
            match (&member.row, member.parent) {
                (Some(row), Some(parent)) => {
                    remote_call(&mut related, chain.members[parent].id(), row)
                }
                _ => {
                    let links = self.related(&id)?;
                    related.entry(id.clone()).or_insert(links);
                }
            }
            order.push(id);
        }
        for linked in linked_ids(&related[id]) {
            if order.len() >= SNAPSHOT_TRACES || order.contains(&linked) {
                continue;
            }
            if let Some(doc) = self.get_trace(&linked)? {
                docs.insert(linked.clone(), document(&doc, values));
                related.insert(linked.clone(), self.related(&linked)?);
                order.push(linked);
            }
        }
        // The chain as `api/traces/{id}/chain` answers it, without the documents (they are in `traces`).
        let traces = chain.select(&Selection::default()).traces();
        let issues: Vec<Value> = chain_issues(&chain)
            .into_iter()
            .map(|(at, mut issue)| {
                issue["trace_id"] = Value::from(chain.members[at].id());
                issue
            })
            .collect();
        Ok(Some(serde_json::json!({
            "format": SNAPSHOT_FORMAT,
            "agent": env!("CARGO_PKG_VERSION"),
            "created": search::now_us(),
            "values": values,
            "root": id,
            "traces": docs,
            "related": related,
            "chain": {"traces": traces, "issues": issues, "capped": chain.capped},
        })))
    }

    pub fn get_trace(&self, id: &str) -> rusqlite::Result<Option<String>> {
        let db = self.connect()?;
        let mut statement = db.prepare("SELECT doc FROM traces WHERE id = ?1")?;
        let mut rows = statement.query([id])?;
        rows.next()?.map(|row| row.get(0)).transpose()
    }

    /// Traces linked to this one, by link kind: tasks (enqueued_by), WebSocket connections and layer messages; and a
    /// task run's workflow, by its task ids.
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
        let linked = Linked {
            by: parents.get("enqueued_by").and_then(|ids| ids.first()),
            enqueued: children.get("enqueued_by").map_or(&[][..], Vec::as_slice),
        };
        let workflow = self.workflow(&db, id, &linked)?;
        let mut related = serde_json::json!({
            "enqueued_by": one("enqueued_by")?,
            "enqueued": many("enqueued_by")?,
            "connection": one("connection")?,
            "connection_events": many("connection")?,
            "sent_by": one("sent_by")?,
            "delivered": many("sent_by")?,
            "called_by": one("called_by")?,
            "calls": many("called_by")?,
            "via": via,
        });
        // Only a task run in a workflow has one.
        if !workflow.is_null() {
            related["workflow"] = workflow;
        }
        Ok(related)
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
        // Emails the app sent: only some frameworks send them through what an SDK records (Django's mail).
        let mails: i64 = db.query_row(
            "SELECT count(*) FROM mails WHERE ?1 IS NULL OR trace_id IN (SELECT id FROM traces WHERE service = ?1)",
            [service],
            |row| row.get(0),
        )?;
        // Calls to AWS's APIs: the AWS page is shown once there are any.
        let aws: i64 = db.query_row(
            "SELECT count(*) FROM aws_calls WHERE ?1 IS NULL OR trace_id IN (SELECT id FROM traces WHERE service = ?1)",
            [service],
            |row| row.get(0),
        )?;
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
                "mails": mails,
                "aws": aws,
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

/// The AWS service a server is, in its region, or null: `{"service": "S3", "name": "Amazon S3", "region": ...}`.
fn cloud(row: &serde_json::Map<String, Value>) -> Value {
    let Some(service) = row["cloud_service"].as_str() else {
        return Value::Null;
    };
    serde_json::json!({
        "provider": "aws",
        "service": service,
        "name": tracepanel_analysis::aws::service_name(service),
        "region": row["cloud_region"],
    })
}

/// One column of each system's operations, its distinct values for the console's filters: the targets (databases,
/// instances, hosts, topics) or the operations (SELECT, GET, find, publish).
/// The apps with rows on each page, by the page's name in the console (`endpoints`, `logs`, `calls/sql`…): what its
/// App menu offers. With `service`, only that app.
fn apps_by_page(db: &Connection, service: &str) -> rusqlite::Result<Value> {
    let scope = if service.is_empty() {
        "1"
    } else {
        "service = ?1"
    };
    // A page's traces: the condition on the traces table that finds the traces behind its rows.
    let pages = [
        ("traces", "1"),
        ("services", "1"),
        ("endpoints", "kind = 'http' AND route IS NOT NULL"),
        ("graphql", "kind = 'http' AND name LIKE 'GraphQL %'"),
        ("tasks", "kind = 'task'"),
        ("websockets", "kind = 'websocket'"),
        ("jobs", "kind = 'command'"),
        ("rpc", "kind = 'rpc'"),
        ("pages", "kind = 'page'"),
        ("logs", "id IN (SELECT trace_id FROM logs)"),
        ("mails", "id IN (SELECT trace_id FROM mails)"),
        ("aws", "id IN (SELECT trace_id FROM aws_calls)"),
        (
            "errors",
            "id IN (SELECT trace_id FROM issue_traces JOIN issues USING (fingerprint) WHERE issues.kind = 'error')",
        ),
        (
            "issues",
            "id IN (SELECT trace_id FROM issue_traces JOIN issues USING (fingerprint) WHERE issues.kind != 'error')",
        ),
    ];
    let mut union: Vec<String> = pages
        .iter()
        .map(|(page, condition)| {
            format!("SELECT '{page}' AS page, service FROM traces WHERE {condition} AND {scope}")
        })
        .collect();
    // Each system's calls page.
    union.push(format!(
        "SELECT 'calls/' || calls.system, traces.service FROM calls JOIN traces ON traces.id = calls.trace_id \
         WHERE {}",
        scope.replace("service", "traces.service")
    ));
    let mut statement = db.prepare(&format!(
        "SELECT DISTINCT page, service FROM ({}) WHERE service != '' ORDER BY 1, 2",
        union.join(" UNION ALL ")
    ))?;
    let params: Vec<&dyn rusqlite::ToSql> = if statement.parameter_count() == 0 {
        vec![]
    } else {
        vec![&service]
    };
    let mut by_page = serde_json::Map::new();
    let rows = statement.query_map(params.as_slice(), |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    for row in rows {
        let (page, app) = row?;
        by_page
            .entry(page)
            .or_insert_with(|| Value::Array(Vec::new()))
            .as_array_mut()
            .expect("an array")
            .push(Value::from(app));
    }
    Ok(Value::Object(by_page))
}

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
        (Some("nodejs" | "js"), Some("bun")) => Some("Bun".into()),
        (Some("nodejs" | "js"), Some("deno")) => Some("Deno".into()),
        (Some("nodejs"), _) => Some("Node".into()),
        // OpenTelemetry's other language names, as people write them.
        (Some("dotnet"), _) => Some(".NET".into()),
        (Some("cpp"), _) => Some("C++".into()),
        (Some("php"), _) => Some("PHP".into()),
        _ => language,
    }
}

/// A language's version as people say it: Java by its feature release (21, not 21.0.9+10-LTS; 8 for 1.8.0_392),
/// the others by major and minor.
fn short_version(language: &str, version: &str) -> String {
    let version = version.split(['+', '-']).next().unwrap_or(version);
    let mut parts = version.split(['.', '_']);
    if language == "Java" {
        return match (parts.next(), parts.next()) {
            (Some("1"), Some(minor)) => minor.to_owned(),
            (Some(feature), _) => feature.to_owned(),
            _ => version.to_owned(),
        };
    }
    version.split('.').take(2).collect::<Vec<_>>().join(".")
}

/// What runs an app, from one of its traces' attributes: its language and version, its framework.
fn runtime_of(attrs: Option<&str>) -> Option<String> {
    let attrs: serde_json::Map<String, Value> = attrs
        .and_then(|text| serde_json::from_str(text).ok())
        .unwrap_or_default();
    let text = |key: &str| attrs.get(key).and_then(Value::as_str).map(str::to_owned);
    runtime_label(
        language_name(text("telemetry.sdk.language"), text("process.runtime.name")),
        text("tracepanel.language.version").or_else(|| text("process.runtime.version")),
        text("tracepanel.framework"),
    )
}

/// Edges of one app role, peer and direction as one: a role read from a trace's kind may be one its SDK named too.
fn merged_edges(edges: Vec<Value>) -> Vec<Value> {
    let mut at: HashMap<String, usize> = HashMap::new();
    let mut merged: Vec<Value> = Vec::new();
    for edge in edges {
        let key = ["service", "role", "peer", "direction"]
            .map(|field| edge[field].as_str().unwrap_or(""))
            .join("\u{0}");
        match at.get(&key) {
            Some(&index) => {
                for field in ["traces", "calls", "total", "errors"] {
                    let sum = merged[index][field].as_i64().unwrap_or(0)
                        + edge[field].as_i64().unwrap_or(0);
                    merged[index][field] = Value::from(sum);
                }
            }
            None => {
                at.insert(key, merged.len());
                merged.push(edge);
            }
        }
    }
    merged
}

/// One app role's numbers, summed over its traces' groups (a role the SDK named, one taken from the traces' kind).
#[derive(Default)]
struct App {
    traces: i64,
    errors: i64,
    total: i64,
    last_seen: i64,
    runtime: Option<String>,
    runtime_seen: i64,
    /// Its traces' durations, for its percentiles.
    durations: Vec<i64>,
    /// The issues its traces raised, by fingerprint.
    issues: BTreeSet<String>,
}

/// A GROUP_CONCAT of integers, read back.
fn numbers(row: &serde_json::Map<String, Value>, key: &str) -> Vec<i64> {
    row[key]
        .as_str()
        .map(|text| text.split(',').filter_map(|one| one.parse().ok()).collect())
        .unwrap_or_default()
}

/// What runs an app, as the SDKs label it for the panel: "Python 3.12 · Django 6.0", "Go 1.27", "Java 21 · Spring
/// Boot 4.1". A Kotlin app names Kotlin's own version (tracepanel.language.version), not the JVM's.
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
    let runtime = match version {
        Some(version) => format!("{language} {}", short_version(&language, &version)),
        None => language,
    };
    Some(match framework {
        Some(framework) => {
            // A framework's version is its last word: "Spring Boot 4.1.1", "Next.js 16.4.0".
            let framework = match framework.rsplit_once(' ') {
                Some((name, version)) if version.starts_with(|c: char| c.is_ascii_digit()) => {
                    format!("{name} {}", short_version(name, version))
                }
                _ => framework,
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

/// Another project's trace in a snapshot's links of the trace whose call reached it, as the console lists it.
fn remote_call(related: &mut serde_json::Map<String, Value>, owner: &str, row: &Value) {
    if let Some(Value::Object(links)) = related.get_mut(owner)
        && let Some(calls) = links
            .entry("remote_calls")
            .or_insert_with(|| Value::Array(Vec::new()))
            .as_array_mut()
    {
        calls.push(row.clone());
    }
}

/// A stored document as a snapshot carries it: as it is, or without what stays local.
fn document(doc: &str, values: bool) -> Value {
    stored(serde_json::from_str(doc).unwrap_or(Value::Null), values)
}

/// A trace document as a snapshot carries it.
fn stored(mut doc: Value, values: bool) -> Value {
    if !values {
        tracepanel_protocol::local::strip(&mut doc);
    }
    doc
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
    // A task run's workflow: its root, the steps before and after it, its group's other tasks, its graph.
    let workflow = &related["workflow"];
    let steps = [
        &workflow["follows"],
        &workflow["followed_by"],
        &workflow["group"]["runs"],
    ];
    ids.extend(
        std::iter::once(&workflow["root"])
            .chain(steps.into_iter().filter_map(Value::as_array).flatten())
            .filter_map(|item| item["id"].as_str().map(str::to_owned)),
    );
    // The rest of its graph: a snapshot opens every run the graph shows.
    ids.extend(
        workflow["graph"]["nodes"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|node| node["trace"]["id"].as_str().map(str::to_owned)),
    );
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

    #[test]
    fn every_opentelemetry_language_is_named_as_people_write_it() {
        let named = |language: &str, runtime: Option<&str>| {
            language_name(Some(language.into()), runtime.map(str::to_owned))
        };

        assert_eq!(
            [
                named("dotnet", None),
                named("cpp", None),
                named("php", None),
                named("js", Some("deno")),
                named("ruby", None),
            ],
            [
                Some(".NET".to_owned()),
                Some("C++".to_owned()),
                Some("PHP".to_owned()),
                Some("Deno".to_owned()),
                Some("ruby".to_owned()),
            ]
        );
        assert_eq!(
            label(Some("ruby"), Some("3.4.1"), Some("Rails 8.0.2")).as_deref(),
            Some("Ruby 3.4 · Rails 8.0")
        );
        assert_eq!(
            label(Some(".NET"), Some("9.0.4"), Some("ASP.NET Core 9.0.4")).as_deref(),
            Some(".NET 9.0 · ASP.NET Core 9.0")
        );
    }

    #[test]
    fn a_jvm_app_is_labelled_by_its_language_and_framework() {
        assert_eq!(
            label(Some("java"), Some("21.0.9"), Some("Spring Boot 4.1.1")).as_deref(),
            Some("Java 21 · Spring Boot 4.1")
        );
        // OpenTelemetry's Java agent sends the JVM's full version; Java 8 calls itself 1.8.
        assert_eq!(
            label(Some("java"), Some("21.0.9+10-LTS"), None).as_deref(),
            Some("Java 21")
        );
        assert_eq!(
            label(Some("java"), Some("1.8.0_392"), None).as_deref(),
            Some("Java 8")
        );
        assert_eq!(
            label(Some("kotlin"), Some("2.3.0"), Some("Ktor 3.2.1")).as_deref(),
            Some("Kotlin 2.3 · Ktor 3.2")
        );
    }
}
