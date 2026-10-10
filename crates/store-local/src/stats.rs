//! Statistics over traces: percentiles, series over time, latency histograms.

use super::*;

/// Requests at least this slow count as slow in the overview.
pub const SLOW_REQUEST_US: i64 = 500_000;

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
    let start = start.or_else(|| rows.first().map(|row| int(row, "start")));
    let end = end.or_else(|| rows.last().map(|row| int(row, "start")));
    let (Some(start), Some(end)) = (start, end) else {
        return serde_json::json!({"summary": null, "series": [], "histogram": []});
    };
    if end < start {
        return serde_json::json!({"summary": null, "series": [], "histogram": []});
    }
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
                "slow": values.iter().filter(|value| **value >= SLOW_REQUEST_US).count(),
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
            "slow": durations.iter().filter(|value| **value >= SLOW_REQUEST_US).count(),
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
