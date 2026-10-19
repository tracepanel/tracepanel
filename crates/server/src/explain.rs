//! EXPLAIN of a recorded query, run by the app that recorded it: the agent has no way to the app's database, the app
//! has its connection. The agent writes the statement for the database (EXPLAIN, EXPLAIN ANALYZE), sends it down the
//! app's connection (`Apps::ask`), and reads the plan the rows make: one implementation for every SDK.

use serde_json::{Map, Value, json};

/// What to ask the app: the EXPLAIN to run, its parameters, and which database (the span's).
pub(crate) struct Request {
    pub vendor: String,
    pub alias: String,
    pub analyze: bool,
    pub body: Value,
}

/// The request for a span, or why there is none (with the status to answer).
pub(crate) fn request(span: &Map<String, Value>, analyze: bool) -> Result<Request, (u16, String)> {
    if span.get("kind").and_then(Value::as_str) != Some("sql") {
        return Err((404, "not found".into()));
    }
    let attrs = span
        .get("attrs")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let text = |key: &str| {
        attrs
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    let statement = text("db.statement");
    let first = statement
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    if first != "SELECT" && first != "WITH" {
        return Err((422, "Only SELECT statements can be explained.".into()));
    }
    // A query with no placeholder has no parameters to record.
    let params = match attrs.get("db.params").and_then(Value::as_array) {
        Some(params) => params.clone(),
        None if !has_placeholders(&statement) => Vec::new(),
        None => return Err((422, "Parameters of this query were not recorded.".into())),
    };
    let vendor = [text("db.system"), text("db.vendor")]
        .into_iter()
        .find(|vendor| !vendor.is_empty())
        .unwrap_or_default();
    let (prefix, analyzed) = match vendor.as_str() {
        "sqlite" => ("EXPLAIN QUERY PLAN ", false),
        "postgresql" if analyze => ("EXPLAIN (ANALYZE, BUFFERS) ", true),
        "mysql" | "mariadb" if analyze => ("EXPLAIN ANALYZE ", true),
        _ => ("EXPLAIN ", false),
    };
    let alias = [text("db.alias")]
        .into_iter()
        .find(|alias| !alias.is_empty())
        .unwrap_or_else(|| "default".into());
    Ok(Request {
        body: json!({"explain": {
            "sql": format!("{prefix}{statement}"),
            "params": params,
            "vendor": vendor,
            "alias": alias,
            "server": attrs.get("server.address"),
            "port": attrs.get("server.port"),
            "database": attrs.get("db.namespace").or_else(|| attrs.get("db.name")),
            // EXPLAIN ANALYZE runs the query: the app rolls back whatever it did.
            "analyze": analyzed,
        }}),
        vendor,
        alias,
        analyze: analyzed,
    })
}

/// Whether a statement takes parameters: `%s`, `%(name)s`, `?`, `:name` (not a `::` cast) or `$1`, outside its
/// quoted strings and names and its comments.
fn has_placeholders(statement: &str) -> bool {
    let chars: Vec<char> = statement.chars().collect();
    let mut at = 0;
    while let Some(&char) = chars.get(at) {
        let next = chars.get(at + 1).copied().unwrap_or_default();
        let skipped = match (char, next) {
            ('\'' | '"' | '`', _) => Some(closing(&chars, at + 1, &[char])),
            ('-', '-') => Some(closing(&chars, at + 2, &['\n'])),
            ('/', '*') => Some(closing(&chars, at + 2, &['*', '/'])),
            _ => None,
        };
        if let Some(end) = skipped {
            at = end;
            continue;
        }
        let before = at
            .checked_sub(1)
            .and_then(|before| chars.get(before))
            .copied();
        let placeholder = match char {
            '%' => next == 's' || next == '(',
            '?' => true,
            ':' => before != Some(':') && (next.is_ascii_alphabetic() || next == '_'),
            '$' => next.is_ascii_digit(),
            _ => false,
        };
        if placeholder {
            return true;
        }
        at += 1;
    }
    false
}

/// Where a quote or comment that opened before `from` ends: just past `end`, or the statement's end.
fn closing(chars: &[char], from: usize, end: &[char]) -> usize {
    (from..chars.len())
        .find(|&at| chars[at..].starts_with(end))
        .map_or(chars.len(), |at| at + end.len())
}

/// The plan the app's rows make: lines with their depth and what to look at (a full scan, a sort that spills).
pub(crate) fn plan(request: &Request, answer: &Value) -> Value {
    let columns: Vec<String> = answer
        .get("columns")
        .and_then(Value::as_array)
        .map(|columns| {
            columns
                .iter()
                .map(|column| column.as_str().unwrap_or_default().to_owned())
                .collect()
        })
        .unwrap_or_default();
    let rows: Vec<Vec<Value>> = answer
        .get("rows")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .map(|row| row.as_array().cloned().unwrap_or_default())
                .collect()
        })
        .unwrap_or_default();
    let lines = match request.vendor.as_str() {
        "sqlite" => sqlite(&rows),
        _ if columns.len() == 1 => text_plan(&rows),
        _ => table(&columns, &rows),
    };
    json!({"vendor": request.vendor, "alias": request.alias, "analyzed": request.analyze, "lines": lines})
}

fn line(depth: usize, text: String, warning: Option<String>) -> Value {
    json!({"depth": depth, "text": text, "warning": warning})
}

fn cell(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// SQLite's (id, parent, notused, detail): depth follows the parent chain.
fn sqlite(rows: &[Vec<Value>]) -> Vec<Value> {
    let mut depth = std::collections::HashMap::from([(0i64, -1i64)]);
    rows.iter()
        .map(|row| {
            let id = row.first().and_then(Value::as_i64).unwrap_or(0);
            let parent = row.get(1).and_then(Value::as_i64).unwrap_or(0);
            let level = depth.get(&parent).copied().unwrap_or(-1) + 1;
            depth.insert(id, level);
            let detail = row.get(3).map(cell).unwrap_or_default();
            let warning = detail
                .strip_prefix("SCAN ")
                .filter(|scan| !scan.contains(" USING "))
                .map(|scan| {
                    let table = scan
                        .trim_start_matches("TABLE ")
                        .split_whitespace()
                        .next()
                        .unwrap_or_default();
                    format!("Full scan of {table}: no index is used")
                });
            line(level.max(0) as usize, detail, warning)
        })
        .collect()
}

/// A plan as text (PostgreSQL, MySQL's ANALYZE, H2): "->" nodes indented 6 a level, their details 2 deeper.
fn text_plan(rows: &[Vec<Value>]) -> Vec<Value> {
    rows.iter()
        .flat_map(|row| {
            row.first()
                .map(cell)
                .unwrap_or_default()
                .lines()
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .map(|text| {
            let trimmed = text.trim();
            let indent = text.len() - text.trim_start().len();
            let node = trimmed.starts_with("->");
            let body = trimmed.trim_start_matches("->").trim().to_owned();
            let depth = if node {
                (indent + 2) / 6
            } else {
                (indent + 4) / 6
            };
            let warning = if let Some(rest) = body.split("Seq Scan on ").nth(1) {
                let table = rest.split_whitespace().next().unwrap_or_default();
                Some(format!("Sequential scan of {table}: no index is used"))
            } else if body.contains("Sort Method: external") {
                Some("Sort spills to disk".to_owned())
            } else {
                None
            };
            line(depth, body, warning)
        })
        .collect()
}

/// A tabular plan (MySQL's EXPLAIN): one line per row, as `column=value` pairs.
fn table(columns: &[String], rows: &[Vec<Value>]) -> Vec<Value> {
    rows.iter()
        .map(|row| {
            let pairs: Vec<String> = columns
                .iter()
                .zip(row)
                .filter(|(_, value)| !value.is_null())
                .map(|(column, value)| format!("{column}={}", cell(value)))
                .collect();
            line(0, pairs.join("  "), None)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sql(statement: &str, params: Option<Value>) -> Result<Request, (u16, String)> {
        let mut attrs = json!({"db.system": "sqlite", "db.statement": statement});
        if let Some(params) = params {
            attrs["db.params"] = params;
        }
        let span = json!({"kind": "sql", "attrs": attrs});
        request(span.as_object().unwrap(), false)
    }

    #[test]
    fn a_query_with_no_placeholder_is_explained_with_no_parameters() {
        for statement in [
            "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND NOT name = 'sqlite_sequence'",
            "SELECT name FROM users WHERE name = ':name?' -- by %s",
            "SELECT id::text FROM users /* $1 */",
        ] {
            let explained =
                sql(statement, None).map(|request| request.body["explain"]["params"].clone());

            assert_eq!(explained, Ok(json!([])), "{statement}");
        }
    }

    #[test]
    fn a_query_with_placeholders_needs_its_parameters() {
        for statement in [
            "SELECT * FROM users WHERE id = %s",
            "SELECT * FROM users WHERE id = %(id)s",
            "SELECT * FROM users WHERE id = ?",
            "SELECT * FROM users WHERE id = :id",
            "SELECT * FROM users WHERE id = $1",
        ] {
            assert_eq!(
                sql(statement, None).err(),
                Some((
                    422,
                    "Parameters of this query were not recorded.".to_owned()
                )),
                "{statement}"
            );
        }

        let explained = sql("SELECT * FROM users WHERE id = ?", Some(json!([7])));

        assert_eq!(
            explained.map(|request| request.body["explain"]["params"].clone()),
            Ok(json!([7]))
        );
    }
}
