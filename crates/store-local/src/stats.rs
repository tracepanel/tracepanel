//! Statistics over traces: percentiles, series over time, latency histograms.

use super::*;

/// A request (HTTP, GraphQL, RPC) is slow from this long.
pub const SLOW_REQUEST_US: i64 = 1_000_000;
/// A page's view (a load, a route change) is slow from this long: where a page's largest paint stops being good.
pub const SLOW_VIEW_US: i64 = 2_500_000;
/// What a user did on a page (a click, a submit) is slow from this long: an answer they wait for.
pub const SLOW_ACTION_US: i64 = 1_000_000;

/// From how long a trace is slow, by what it is: a request, a page's view, an action on a page. Tasks, jobs and
/// WebSocket connections run as long as their work does: none (a task's wait in its queue is its issue instead).
pub fn slow_from(kind: &str, name: &str) -> Option<i64> {
    match kind {
        "task" | "command" | "websocket" => None,
        // An action is named after its page: `/books › click "Save"`.
        "page" if name.contains(" › ") => Some(SLOW_ACTION_US),
        "page" => Some(SLOW_VIEW_US),
        _ => Some(SLOW_REQUEST_US),
    }
}

/// `slow_from` in SQL, over the traces table's `kind` and `name`: `has:slow`.
pub(crate) const SLOW_FROM_SQL: &str = "CASE WHEN kind IN ('task', 'command', 'websocket') THEN NULL \
     WHEN kind = 'page' AND instr(name, ' › ') > 0 THEN 1000000 WHEN kind = 'page' THEN 2500000 ELSE 1000000 END";

fn text<'a>(row: &'a serde_json::Map<String, Value>, key: &str) -> &'a str {
    row.get(key).and_then(Value::as_str).unwrap_or("")
}

/// A trace slow for what it is (`slow_from`).
pub(crate) fn is_slow(row: &serde_json::Map<String, Value>) -> bool {
    slow_from(text(row, "kind"), text(row, "name")).is_some_and(|from| int(row, "duration") >= from)
}

/// The rule these traces are held to, said as the overview says it, and its lowest limit: none when no trace of
/// them is held to one (tasks, jobs).
pub fn slow_rule(rows: &[serde_json::Map<String, Value>]) -> (Option<String>, Option<i64>) {
    let (mut views, mut actions, mut requests) = (false, false, false);
    for row in rows {
        match (
            text(row, "kind"),
            slow_from(text(row, "kind"), text(row, "name")),
        ) {
            (_, None) => {}
            ("page", Some(SLOW_VIEW_US)) => views = true,
            ("page", Some(_)) => actions = true,
            _ => requests = true,
        }
    }
    let mut parts = Vec::new();
    if requests {
        parts.push("requests ≥ 1 s");
    }
    if views {
        parts.push("views ≥ 2.5 s");
    }
    if actions {
        parts.push("actions ≥ 1 s");
    }
    let lowest = if requests || actions {
        Some(SLOW_REQUEST_US.min(SLOW_ACTION_US))
    } else if views {
        Some(SLOW_VIEW_US)
    } else {
        None
    };
    ((!parts.is_empty()).then(|| parts.join(" · ")), lowest)
}

/// Python's round(x, 1): half to even on the exact value, as the shortest decimal shows it.
pub(crate) fn round1(value: f64) -> f64 {
    format!("{value:.1}").parse().unwrap_or(value)
}

/// Nearest-rank percentile of sorted values.
pub(crate) fn pct(values: &[i64], p: f64) -> i64 {
    if values.is_empty() {
        return 0;
    }
    values[((values.len() as f64 * p) as usize).min(values.len() - 1)]
}

pub(crate) fn int(row: &serde_json::Map<String, Value>, key: &str) -> i64 {
    row.get(key).and_then(Value::as_i64).unwrap_or(0)
}

/// The shortest window a series spans when no period is asked for: 10 minutes up to the last call.
const MIN_WINDOW_US: i64 = 10 * 60 * 1_000_000;

/// Failed work: the trace ended in error or answered 5xx.
pub(crate) fn is_error(row: &serde_json::Map<String, Value>) -> bool {
    row.get("status").and_then(Value::as_str) == Some("error") || int(row, "http_status") >= 500
}

/// Summary, time series and latency histogram of traces ordered by start; the series spans [start, end].
pub fn stats(
    rows: &[serde_json::Map<String, Value>],
    buckets: i64,
    start: Option<i64>,
    end: Option<i64>,
) -> Value {
    let asked = start;
    let end = end.or_else(|| rows.last().map(|row| int(row, "start")));
    let start = start.or_else(|| rows.first().map(|row| int(row, "start")));
    let (Some(start), Some(end)) = (start, end) else {
        return serde_json::json!({"summary": null, "series": [], "histogram": []});
    };
    if end < start {
        return serde_json::json!({"summary": null, "series": [], "histogram": []});
    }
    // Without a period asked for, calls close together (one call, a burst) still get a window to stand in: the
    // series would span a moment, every bucket the same time.
    let start = if asked.is_none() {
        start.min(end - MIN_WINDOW_US)
    } else {
        start
    };
    let mut durations: Vec<i64> = rows.iter().map(|row| int(row, "duration")).collect();
    durations.sort_unstable();
    let width = ((end - start) / buckets + 1).max(1);
    let series: Vec<Value> = (0..buckets)
        .map(|index| {
            let low = start + index * width;
            let bucket: Vec<&serde_json::Map<String, Value>> =
                rows.iter().filter(|row| (low..low + width).contains(&int(row, "start"))).collect();
            let mut values: Vec<i64> = bucket.iter().map(|row| int(row, "duration")).collect();
            values.sort_unstable();
            serde_json::json!({
                "start": low,
                "end": low + width,
                "calls": bucket.len(),
                "errors": bucket.iter().filter(|row| is_error(row)).count(),
                "slow": bucket.iter().filter(|row| is_slow(row)).count(),
                "p50": if values.is_empty() { Value::Null } else { Value::from(pct(&values, 0.5)) },
                "p95": if values.is_empty() { Value::Null } else { Value::from(pct(&values, 0.95)) },
            })
        })
        .collect();
    // Log-spaced latency buckets from 100 µs up, doubling per bucket.
    let edges: Vec<i64> = (0..22).map(|i| 100 * 2_i64.pow(i)).collect();
    let mut histogram: Vec<(i64, i64, usize)> = std::iter::once(0)
        .chain(edges[..edges.len() - 1].iter().copied())
        .zip(edges.iter().copied())
        .map(|(low, high)| {
            (
                low,
                high,
                durations
                    .iter()
                    .filter(|d| low <= **d && **d < high)
                    .count(),
            )
        })
        .collect();
    while histogram.last().is_some_and(|bucket| bucket.2 == 0) {
        histogram.pop();
    }
    while histogram.len() > 1 && histogram[0].2 == 0 && histogram[1].2 == 0 {
        histogram.remove(0);
    }
    let histogram: Vec<Value> = histogram
        .into_iter()
        .map(|(from, to, count)| serde_json::json!({"from": from, "to": to, "count": count}))
        .collect();
    if rows.is_empty() {
        return serde_json::json!({"summary": null, "series": series, "histogram": histogram});
    }
    let mean =
        |key: &str| rows.iter().map(|row| int(row, key) as f64).sum::<f64>() / rows.len() as f64;
    serde_json::json!({
        "summary": {
            "calls": rows.len(),
            "errors": rows.iter().filter(|row| is_error(row)).count(),
            "slow": rows.iter().filter(|row| is_slow(row)).count(),
            "p50": pct(&durations, 0.5),
            "p75": pct(&durations, 0.75),
            "p90": pct(&durations, 0.9),
            "p95": pct(&durations, 0.95),
            "p99": pct(&durations, 0.99),
            "max": durations.last().copied().unwrap_or(0),
            "avg_queries": round1(mean("queries")),
            "avg_db_time": mean("db_time").round_ties_even() as i64,
            "with_issues": rows.iter().filter(|row| int(row, "issues") != 0).count(),
            "first_seen": int(&rows[0], "start"),
            "last_seen": int(&rows[rows.len() - 1], "start"),
        },
        "series": series,
        "histogram": histogram,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const TRACES: [(&str, &str); 6] = [
        ("http", "GET /books"),
        ("page", "/books"),
        ("page", "/books › click \"Save\""),
        ("task", "shop.tasks.send"),
        ("command", "import_books"),
        ("websocket", "/ws/chat"),
    ];

    fn row(kind: &str, name: &str, duration: i64) -> serde_json::Map<String, Value> {
        let Value::Object(row) =
            serde_json::json!({"kind": kind, "name": name, "duration": duration})
        else {
            unreachable!()
        };
        row
    }

    #[test]
    fn a_trace_is_slow_from_a_limit_of_its_kind() {
        let limits: Vec<Option<i64>> = TRACES
            .iter()
            .map(|(kind, name)| slow_from(kind, name))
            .collect();

        assert_eq!(
            limits,
            [
                Some(1_000_000),
                Some(2_500_000),
                Some(1_000_000),
                None,
                None,
                None
            ]
        );

        assert!(is_slow(&row("http", "GET /books", 1_000_000)));
        assert!(!is_slow(&row("http", "GET /books", 999_999)));
        assert!(!is_slow(&row("page", "/books", 2_000_000)));
        assert!(!is_slow(&row("task", "shop.tasks.send", 60_000_000)));
    }

    #[test]
    fn has_slow_holds_a_trace_to_the_same_limit_in_sql() {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        let limits: Vec<Option<i64>> = TRACES
            .iter()
            .map(|(kind, name)| {
                db.query_row(
                    &format!("SELECT {SLOW_FROM_SQL} FROM (SELECT ?1 AS kind, ?2 AS name)"),
                    [kind, name],
                    |row| row.get(0),
                )
                .unwrap()
            })
            .collect();

        let expected: Vec<Option<i64>> = TRACES
            .iter()
            .map(|(kind, name)| slow_from(kind, name))
            .collect();
        assert_eq!(limits, expected);
    }

    #[test]
    fn the_overview_says_the_rule_its_traces_are_held_to() {
        let pages = [
            row("page", "/books", 0),
            row("page", "/books › click \"Save\"", 0),
        ];
        let requests = [row("http", "GET /books", 0)];
        let tasks = [row("task", "shop.tasks.send", 0)];

        assert_eq!(
            slow_rule(&pages),
            (
                Some("views ≥ 2.5 s · actions ≥ 1 s".into()),
                Some(1_000_000)
            )
        );
        assert_eq!(
            slow_rule(&requests),
            (Some("requests ≥ 1 s".into()), Some(1_000_000))
        );
        assert_eq!(slow_rule(&tasks), (None, None));
    }
}
