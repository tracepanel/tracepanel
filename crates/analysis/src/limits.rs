//! The limits a span is held to, by its database: the app's own for that database first (`slow_sql_ms_by_db`,
//! `long_transaction_ms_by_db`), else for an analytical warehouse the agent's own, else the app's for every database.
//!
//! A warehouse (Snowflake, BigQuery, Databricks, Redshift, ClickHouse) scans columns across a cluster and answers in
//! seconds by design: held to 100 ms, every query it runs would be slow and every transaction long. Its queries are
//! slow from `WAREHOUSE_SLOW_SQL_MS`, its transactions long from `WAREHOUSE_LONG_TRANSACTION_MS`, unless the app's
//! own limit for every database is higher still.

use serde_json::Value;
use std::collections::BTreeMap;
use tracepanel_protocol::{Attrs, Thresholds};

pub(crate) const WAREHOUSE_SLOW_SQL_MS: i64 = 2_000;
pub(crate) const WAREHOUSE_LONG_TRANSACTION_MS: i64 = 10_000;

/// Analytical warehouses, as the SDKs and OpenTelemetry name them in `db.system` or `db.vendor`: OpenTelemetry's and
/// the Python SDK's names (SQLAlchemy's dialects), and JDBC's product names as the Java SDK writes them (lowercase,
/// without spaces: `Google BigQuery`, Databricks' `SparkSQL`).
const WAREHOUSES: &[&str] = &[
    "snowflake",
    "bigquery",
    "googlebigquery",
    "gcp.bigquery",
    "databricks",
    "sparksql",
    "spark",
    "redshift",
    "aws.redshift",
    "clickhouse",
    "clickhousedb",
];

/// What to do about a slow query on a warehouse: an index or EXPLAIN isn't the way there.
pub(crate) const WAREHOUSE_SLOW_SQL: &str = "An analytical warehouse answers in seconds by design: cache the result, \
                                             pre-aggregate it (a summary table, a materialized view), run the query \
                                             off the request (a background task), or check the warehouse's size and \
                                             its queue.";

/// The span's database, as `db.system` and `db.vendor` name it (one, both or neither).
fn systems(attrs: &Attrs) -> impl Iterator<Item = &str> {
    ["db.system", "db.vendor"]
        .into_iter()
        .filter_map(|key| attrs.get(key).and_then(Value::as_str))
}

/// Whether the span's database is an analytical warehouse.
pub(crate) fn warehouse(attrs: &Attrs) -> bool {
    systems(attrs).any(|system| {
        WAREHOUSES
            .iter()
            .any(|known| known.eq_ignore_ascii_case(system))
    })
}

/// A query on this database is slow from this many milliseconds.
pub(crate) fn slow_sql_ms(thresholds: &Thresholds, attrs: &Attrs) -> i64 {
    limit(
        thresholds.slow_sql_ms,
        &thresholds.slow_sql_ms_by_db,
        WAREHOUSE_SLOW_SQL_MS,
        attrs,
    )
}

/// A transaction on this database is long from this many milliseconds.
pub(crate) fn long_transaction_ms(thresholds: &Thresholds, attrs: &Attrs) -> i64 {
    limit(
        thresholds.long_transaction_ms,
        &thresholds.long_transaction_ms_by_db,
        WAREHOUSE_LONG_TRANSACTION_MS,
        attrs,
    )
}

fn limit(app: i64, by_db: &BTreeMap<String, i64>, warehouse_ms: i64, attrs: &Attrs) -> i64 {
    if !by_db.is_empty() {
        let own = systems(attrs).find_map(|system| {
            by_db
                .iter()
                .find(|(name, _)| name.eq_ignore_ascii_case(system))
                .map(|(_, ms)| *ms)
        });
        if let Some(ms) = own {
            return ms;
        }
    }
    if warehouse(attrs) {
        app.max(warehouse_ms)
    } else {
        app
    }
}
