//! The AWS page: every call to an AWS API (the `aws_calls` table), by service and operation, with where the app
//! makes it from, its errors by code and its retries, and the latest calls of one.

use super::*;
use crate::groups::{Row, busiest, durations, grouped, text_of};
use tracepanel_analysis::aws;

/// How many places a row names (an app's line of code), the most calls first.
const PLACES: usize = 5;

/// What both lists read of a call: its row, and the app that made it (its trace's).
const COLUMNS: &str = "trace_id, span_id, aws_service, operation, region, name, error, error_type, retries, system, \
                       key, start, duration, origin, (SELECT service FROM traces WHERE id = aws_calls.trace_id) AS app";

pub(crate) fn aws_search() -> search::Schema {
    search::schema_for(
        "aws",
        &[
            ("aws", "aws_service"),
            ("region", "region"),
            ("error", "error_type"),
            ("since", "start"),
            ("until", "start"),
        ],
        Box::new(|words| {
            let pattern = Sql::Text(format!("%{}%", search::like(words)));
            (
                "name LIKE ? ESCAPE '\\' OR operation LIKE ? ESCAPE '\\' OR aws_service LIKE ? ESCAPE '\\'".into(),
                vec![pattern; 3],
            )
        }),
        vec![
            ("op", lower_text("lower(operation)")),
            ("failed", Box::new(failed)),
            ("service", of_service("trace_id")),
        ],
        vec![],
    )
}

pub(crate) static AWS_SEARCH: std::sync::LazyLock<search::Schema> =
    std::sync::LazyLock::new(aws_search);

/// Counts by a text column's value, the most first (the first seen on a tie).
fn counted(rows: &[Row], value: impl Fn(&Row) -> Option<String>) -> Vec<(String, usize)> {
    let mut found: Vec<(String, usize)> = Vec::new();
    for name in rows.iter().filter_map(value) {
        match found.iter_mut().find(|(known, _)| *known == name) {
            Some((_, count)) => *count += 1,
            None => found.push((name, 1)),
        }
    }
    found.sort_by_key(|(_, count)| std::cmp::Reverse(*count));
    found
}

fn text_in(row: &Row, key: &str) -> Option<String> {
    row.get(key).and_then(Value::as_str).map(str::to_owned)
}

/// One service's operation: its calls, how long they took, which failed with which code, the retries, where the
/// app makes them from, and the page of operations that lists them (S3's Storage, DynamoDB's).
fn operation_row(rows: &[Row]) -> Value {
    let first = &rows[0];
    let service = text_in(first, "aws_service").unwrap_or_default();
    let durations = durations(rows);
    let traces: BTreeSet<String> = rows
        .iter()
        .filter_map(|row| text_in(row, "trace_id"))
        .collect();
    let latest = rows
        .iter()
        .max_by_key(|row| int(row, "start"))
        .unwrap_or(first);
    let codes = counted(rows, |row| text_in(row, "error_type"));
    let places = counted(rows, |row| {
        text_in(row, "origin")
            .map(|origin| format!("{}\u{0}{origin}", text_in(row, "app").unwrap_or_default()))
    });
    let system = counted(rows, |row| text_in(row, "system"));
    serde_json::json!({
        "aws_service": service,
        "name": aws::service_name(&service),
        "operation": first["operation"],
        "regions": counted(rows, |row| text_in(row, "region")).into_iter().map(|(region, _)| region).collect::<Vec<_>>(),
        "system": system.first().map(|(system, _)| system.clone()),
        "calls": rows.len(),
        "traces": traces.len(),
        "errors": rows.iter().filter(|row| int(row, "error") != 0).count(),
        "error_codes": codes.into_iter().map(|(code, calls)| serde_json::json!({"code": code, "calls": calls})).collect::<Vec<_>>(),
        "retries": rows.iter().map(|row| int(row, "retries")).sum::<i64>(),
        "retried": rows.iter().filter(|row| int(row, "retries") > 0).count(),
        "p95": pct(&durations, 0.95),
        "total": durations.iter().sum::<i64>(),
        "slowest": durations.last().copied().unwrap_or(0),
        "last_seen": int(latest, "start"),
        "called_from": places.into_iter().take(PLACES).map(|(place, calls)| {
            let (app, origin) = place.split_once('\u{0}').unwrap_or(("", &place));
            serde_json::json!({"service": app, "origin": origin, "calls": calls})
        }).collect::<Vec<_>>(),
        "sample_trace": latest["trace_id"],
    })
}

/// One call, as the list of an operation's calls shows it.
fn call_row(row: Row) -> Value {
    serde_json::json!({
        "trace_id": row["trace_id"],
        "span_id": row["span_id"],
        "service": row["app"],
        "aws_service": row["aws_service"],
        "operation": row["operation"],
        "region": row["region"],
        "name": row["name"],
        "failed": int(&row, "error") != 0,
        "error_type": row["error_type"],
        "retries": int(&row, "retries"),
        "origin": row["origin"],
        "start": row["start"],
        "duration": row["duration"],
    })
}

impl Reader {
    /// Calls to AWS by service and operation, the most time first.
    pub fn list_aws(&self, query: &str, limit: i64) -> Result<Vec<Value>, ReadError> {
        let (condition, params) = search::compile_where(query, &AWS_SEARCH)?;
        let db = self.connect()?;
        let rows = objects(
            &db,
            &format!("SELECT {COLUMNS} FROM aws_calls WHERE {condition}"),
            params,
        )?;
        let items = grouped(rows, |row| {
            format!(
                "{} {}",
                text_of(&row["aws_service"]),
                text_of(&row["operation"])
            )
        })
        .into_iter()
        .map(|(_, rows)| operation_row(&rows))
        .collect();
        Ok(busiest(items, limit))
    }

    /// The latest calls to AWS matching `query` (one operation's: `aws:S3 op:GetObject`), newest first.
    pub fn list_aws_calls(&self, query: &str, limit: i64) -> Result<Vec<Value>, ReadError> {
        let (condition, mut params) = search::compile_where(query, &AWS_SEARCH)?;
        params.push(Sql::Integer(limit));
        let db = self.connect()?;
        let rows = objects(
            &db,
            &format!(
                "SELECT {COLUMNS} FROM aws_calls WHERE {condition} ORDER BY start DESC LIMIT ?"
            ),
            params,
        )?;
        Ok(rows.into_iter().map(call_row).collect())
    }
}
