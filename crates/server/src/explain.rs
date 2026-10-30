//! EXPLAIN of a recorded query, run by the app that recorded it: the agent has no way to the app's database, the app
//! has its connection. The agent writes the statement for the database (EXPLAIN, EXPLAIN ANALYZE), sends it down the
//! app's connection (`Apps::ask`), and reads the plan the rows make (one implementation for the SDKs that send only
//! the rows), or takes the app's own lines when it sends them.

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
    let first = after_comments(&statement)
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
    let mut body = json!({"explain": {
            "sql": format!("{prefix}{statement}"),
            "params": params,
            "vendor": vendor,
            "alias": alias,
            "server": attrs.get("server.address"),
            "port": attrs.get("server.port"),
            "database": attrs.get("db.namespace").or_else(|| attrs.get("db.name")),
            // EXPLAIN ANALYZE runs the query: the app rolls back whatever it did.
            "analyze": analyzed,
    }});
    // Named parameters' names, as the span recorded them: the app passes the values back by name.
    if let Some(names) = attrs.get("db.param_names").filter(|names| names.is_array()) {
        body["explain"]["param_names"] = names.clone();
    }
    Ok(Request {
        body,
        vendor,
        alias,
        analyze: analyzed,
    })
}

/// Whether a statement takes parameters: `%s`, `%(name)s`, `?`, `:name` or `:1` (not a `::` cast), `$1`, or `@P1`
/// and `@name` (not SQL Server's `@@` functions), outside its quoted strings and names (`"`, `` ` ``, `[ ]`) and its
/// comments.
fn has_placeholders(statement: &str) -> bool {
    let chars: Vec<char> = statement.chars().collect();
    let mut at = 0;
    while let Some(&char) = chars.get(at) {
        let next = chars.get(at + 1).copied().unwrap_or_default();
        let skipped = match (char, next) {
            ('\'' | '"' | '`', _) => Some(closing(&chars, at + 1, &[char])),
            ('[', _) if next.is_alphabetic() || next == '_' => {
                Some(closing(&chars, at + 1, &[']']))
            }
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
            ':' => before != Some(':') && (next.is_ascii_alphanumeric() || next == '_'),
            '@' => before != Some('@') && (next.is_ascii_alphanumeric() || next == '_'),
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

/// Where a quote or comment that opened before `from` ends: past its `end`, or at the statement's end.
fn closing(chars: &[char], from: usize, end: &[char]) -> usize {
    (from..chars.len())
        .find(|&at| chars[at..].starts_with(end))
        .map_or(chars.len(), |at| at + end.len())
}

/// The plan: the app's own `lines` when it sends them (Python's, which reads SQL Server's SHOWPLAN and SQLite's temp
/// B-trees), else the lines the app's rows make, with their depth and what to look at (a full scan, a sort that
/// spills).
pub(crate) fn plan(request: &Request, answer: &Value) -> Value {
    let lines = match answer.get("lines").and_then(Value::as_array) {
        Some(lines) => lines.iter().filter_map(own_line).collect(),
        None => from_rows(request, answer),
    };
    json!({"vendor": request.vendor, "alias": request.alias, "analyzed": request.analyze, "lines": lines})
}

/// A line of the app's plan, `{"depth": 1, "text": "...", "warning": "..." | null}`, or None when it isn't one.
fn own_line(own: &Value) -> Option<Value> {
    let depth = own.get("depth")?.as_u64()?;
    let text = own.get("text")?.as_str()?.to_owned();
    let warning = own
        .get("warning")
        .and_then(Value::as_str)
        .map(str::to_owned);
    Some(line(usize::try_from(depth).ok()?, text, warning))
}

/// The lines the app's columns and rows make, as the database answered them (JavaScript's and Java's answer).
fn from_rows(request: &Request, answer: &Value) -> Vec<Value> {
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
    match request.vendor.as_str() {
        "sqlite" => sqlite(&rows),
        _ if columns.len() == 1 => text_plan(&rows),
        _ => table(&columns, &rows),
    }
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

/// A statement from its first word on: its leading comments (an ORM's or sqlcommenter's tags) are not what it does.
fn after_comments(statement: &str) -> &str {
    let mut rest = statement.trim_start();
    loop {
        let skipped = if let Some(comment) = rest.strip_prefix("/*") {
            comment.split_once("*/").map_or("", |(_, after)| after)
        } else if let Some(comment) = rest.strip_prefix("--") {
            comment.split_once('\n').map_or("", |(_, after)| after)
        } else {
            return rest;
        };
        rest = skipped.trim_start();
    }
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

    fn mssql() -> Request {
        let span = json!({"kind": "sql", "attrs": {"db.system": "mssql", "db.statement": "SELECT * FROM books"}});
        request(span.as_object().unwrap(), false).unwrap()
    }

    #[test]
    fn a_select_after_its_comments_is_explained() {
        let commented = sql(
            "/* traceparent='00-1' */ -- a note\nSELECT * FROM books",
            None,
        );
        let update = sql("/* SELECT */ UPDATE books SET n = 1", None);

        assert!(commented.is_ok());
        assert_eq!(
            update.err(),
            Some((422, "Only SELECT statements can be explained.".into()))
        );
    }

    #[test]
    fn the_apps_own_lines_are_the_plan() {
        // Python's SQL Server plan: SHOWPLAN_ALL's rows, read by the app (their columns would make one flat line each).
        let answer = json!({
            "answer": 3, "vendor": "mssql", "alias": "default", "analyzed": false,
            "lines": [
                {"depth": 0, "text": "SELECT * FROM books  (rows=1 cost=0.0033)", "warning": null},
                {"depth": 1, "text": "Table Scan(OBJECT:([shop].[dbo].[books]))  (rows=1 cost=0.0033)",
                 "warning": "Full scan of [shop].[dbo].[books]: no index is used"},
            ],
            "columns": ["StmtText", "NodeId", "Parent", "Type"],
            "rows": [["SELECT * FROM books", 1, 0, "PLAN_ROW"], ["  |--Table Scan(OBJECT:([shop].[dbo].[books]))", 2, 1, "PLAN_ROW"]],
        });

        let explained = plan(&mssql(), &answer);

        assert_eq!(
            explained,
            json!({"vendor": "mssql", "alias": "default", "analyzed": false, "lines": [
                {"depth": 0, "text": "SELECT * FROM books  (rows=1 cost=0.0033)", "warning": null},
                {"depth": 1, "text": "Table Scan(OBJECT:([shop].[dbo].[books]))  (rows=1 cost=0.0033)",
                 "warning": "Full scan of [shop].[dbo].[books]: no index is used"},
            ]})
        );
    }

    #[test]
    fn without_lines_the_rows_are_the_plan() {
        let answer = json!({
            "answer": 3,
            "columns": ["StmtText", "NodeId"],
            "rows": [["SELECT * FROM books", 1], ["|--Table Scan", 2]],
        });

        let explained = plan(&mssql(), &answer);

        assert_eq!(
            explained,
            json!({"vendor": "mssql", "alias": "default", "analyzed": false, "lines": [
                {"depth": 0, "text": "StmtText=SELECT * FROM books  NodeId=1", "warning": null},
                {"depth": 0, "text": "StmtText=|--Table Scan  NodeId=2", "warning": null},
            ]})
        );
    }

    #[test]
    fn a_line_that_isnt_one_is_left_out() {
        let answer = json!({"answer": 3, "lines": [
            {"depth": 0, "text": "SCAN books"},
            {"depth": -1, "text": "negative"},
            {"depth": 1},
            "text",
        ]});

        let explained = plan(&mssql(), &answer);

        assert_eq!(
            explained["lines"],
            json!([{"depth": 0, "text": "SCAN books", "warning": null}])
        );
    }

    #[test]
    fn named_parameters_go_with_their_names() {
        let span = json!({"kind": "sql", "attrs": {
            "db.system": "postgresql", "db.statement": "SELECT * FROM users WHERE age > %(age)s AND name = %(name)s",
            "db.params": [30, "ann"], "db.param_names": ["age", "name"],
        }});

        let explained = request(span.as_object().unwrap(), false).map(|request| request.body);

        assert_eq!(
            explained,
            Ok(json!({"explain": {
                "sql": "EXPLAIN SELECT * FROM users WHERE age > %(age)s AND name = %(name)s",
                "params": [30, "ann"], "param_names": ["age", "name"], "vendor": "postgresql", "alias": "default",
                "server": null, "port": null, "database": null, "analyze": false,
            }}))
        );
    }

    #[test]
    fn positional_parameters_have_no_names() {
        let explained = sql("SELECT * FROM users WHERE id = ?", Some(json!([7])))
            .map(|request| request.body["explain"].get("param_names").cloned());

        assert_eq!(explained, Ok(None));
    }

    #[test]
    fn a_query_with_no_placeholder_is_explained_with_no_parameters() {
        for statement in [
            "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND NOT name = 'sqlite_sequence'",
            "SELECT name FROM users WHERE name = ':name?' -- by %s",
            "SELECT id::text FROM users /* $1 */",
            "SELECT TOP 21 [order?].[id] FROM [order?] WHERE [order?].[at] > '12:30' AND @@ROWCOUNT > 0",
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
            "SELECT TOP 21 [users].[id] FROM [users] WHERE [users].[id] = @P1",
            "SELECT * FROM users WHERE id = @id",
            "SELECT * FROM users WHERE id = :1",
            "SELECT * FROM users WHERE tags = ARRAY[%s]",
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
