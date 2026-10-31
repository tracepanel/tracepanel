//! The search language: free text plus `key:value` / `key>=value` filters, compiled to a parametrized SQLite WHERE
//! clause. Its error messages are shown in the console as they are.

use chrono::{DateTime, Local, NaiveDate, NaiveDateTime, TimeZone};
use regex::Regex;
use rusqlite::types::Value as Sql;
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::LazyLock;

/// The portable field spec (`schema/search.json`), which the console's API serves.
pub const SPEC: &str = include_str!("../../../schema/search.json");

static DURATION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?P<number>\d+(?:\.\d+)?)(?P<unit>us|µs|ms|s)?$").unwrap());
static AGO: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?P<number>\d+)(?P<unit>s|m|h|d)$").unwrap());
pub const LEVELS: [(&str, i64); 5] = [
    ("debug", 10),
    ("info", 20),
    ("warning", 30),
    ("error", 40),
    ("critical", 50),
];

/// A query the user can fix: unknown key, bad value or operator. The message is shown as it is.
#[derive(Debug, Clone, PartialEq)]
pub struct SearchError(pub String);

pub type Clause = Result<(String, Vec<Sql>), SearchError>;
pub type Compiler = Box<dyn Fn(&Term) -> Clause + Send + Sync>;

#[derive(Debug, Clone, PartialEq)]
pub struct Term {
    pub key: Option<String>,
    pub op: String,
    pub value: String,
}

const OPERATORS: [&str; 6] = [">=", "<=", "!=", ":", ">", "<"];

/// The end of a quoted value that starts `text` (at its opening quote), past its closing quote. A quote or a
/// backslash inside it is escaped (name:"/ › click \"Save\""), as the console writes it. None when it never closes.
fn quoted_end(text: &str) -> Option<usize> {
    let mut escaped = false;
    for (at, char) in text.char_indices().skip(1) {
        match char {
            _ if escaped => escaped = false,
            '\\' => escaped = true,
            '"' => return Some(at + 1),
            _ => {}
        }
    }
    None
}

/// One value or word at the start of `text`: quoted, else up to the next space.
fn word_end(text: &str) -> usize {
    let bare = text.find(char::is_whitespace).unwrap_or(text.len());
    if text.starts_with('"') {
        // A quote that never closes is part of a bare word, as a word is anything up to a space.
        return quoted_end(text).unwrap_or(bare);
    }
    bare
}

/// A filter's key and operator at the start of `text` (`status>=`), and where its value starts.
fn key_and_op(text: &str) -> Option<(&str, &'static str, usize)> {
    if !text.starts_with(|char: char| char.is_ascii_lowercase()) {
        return None;
    }
    let key_len = text
        .find(|char: char| {
            !(char.is_ascii_lowercase() || char.is_ascii_digit() || char == '_' || char == '.')
        })
        .unwrap_or(text.len());
    let op = OPERATORS
        .into_iter()
        .find(|op| text[key_len..].starts_with(op))?;
    Some((&text[..key_len], op, key_len + op.len()))
}

/// A value without its quotes, its escaped quotes and backslashes as they are; a bare value as it is.
fn unquote(value: &str) -> String {
    let Some(inner) = value
        .strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
    else {
        return value.trim_matches('"').to_owned();
    };
    if !inner.contains('\\') {
        return inner.to_owned();
    }
    let mut out = String::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(char) = chars.next() {
        match char {
            '\\' => out.extend(chars.next()),
            char => out.push(char),
        }
    }
    out
}

/// A filter at the start of `text` and where it ends. A key with nothing after its operator (`status:`) is a word.
fn filter(text: &str) -> Option<(Term, usize)> {
    let (key, op, at) = key_and_op(text)?;
    let end = at + word_end(&text[at..]);
    let term = Term {
        key: Some(key.to_owned()),
        op: op.to_owned(),
        value: unquote(&text[at..end]),
    };
    (end > at).then_some((term, end))
}

/// The terms of a search, in order: `key:value` filters (any operator) and words of free text, either quoted.
pub fn parse(query: &str) -> Vec<Term> {
    let mut terms = Vec::new();
    let mut rest = query.trim_start();
    while !rest.is_empty() {
        let (term, end) = filter(rest).unwrap_or_else(|| {
            let end = word_end(rest);
            let word = Term {
                key: None,
                op: ":".into(),
                value: unquote(&rest[..end]),
            };
            (word, end)
        });
        terms.push(term);
        rest = rest[end..].trim_start();
    }
    terms
}

/// The search without its filters on `key` (any operator), and those filters alone, each as typed: `duration>500ms
/// route:/a` is `("route:/a", "duration>500ms")` for `duration`.
pub fn split_off(query: &str, key: &str) -> (String, String) {
    let (mut rest, mut those) = (Vec::new(), Vec::new());
    let mut text = query.trim_start();
    while !text.is_empty() {
        let (term, end) = filter(text).unwrap_or_else(|| {
            let end = word_end(text);
            let word = Term {
                key: None,
                op: ":".into(),
                value: String::new(),
            };
            (word, end)
        });
        if term.key.as_deref() == Some(key) {
            those.push(&text[..end]);
        } else {
            rest.push(&text[..end]);
        }
        text = text[end..].trim_start();
    }
    (rest.join(" "), those.join(" "))
}

/// Python's repr() of a string, as error messages quote values.
pub fn py_repr(value: &str) -> String {
    let quote = if value.contains('\'') && !value.contains('"') {
        '"'
    } else {
        '\''
    };
    let mut out = String::from(quote);
    for char in value.chars() {
        match char {
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            char if char == quote => {
                out.push('\\');
                out.push(char);
            }
            char => out.push(char),
        }
    }
    out.push(quote);
    out
}

pub fn like(pattern: &str) -> String {
    pattern
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
        .replace('*', "%")
}

/// `a,b,c` is any of the values.
fn values(term: &Term) -> Vec<String> {
    let found: Vec<String> = term
        .value
        .split(',')
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect();
    if found.is_empty() {
        vec![term.value.clone()]
    } else {
        found
    }
}

fn key(term: &Term) -> &str {
    term.key.as_deref().unwrap_or("")
}

/// Exact match, `*` wildcards allowed, `a,b` for any of them; `!=` negates.
pub fn text(column: &str) -> Compiler {
    let column = column.to_owned();
    Box::new(move |term| {
        if term.op != ":" && term.op != "!=" {
            return Err(SearchError(format!("{} supports only : and !=", key(term))));
        }
        let mut clauses = Vec::new();
        let mut params = Vec::new();
        for value in values(term) {
            if value.contains('*') {
                clauses.push(format!("{column} LIKE ? ESCAPE '\\'"));
                params.push(Sql::Text(like(&value)));
            } else {
                clauses.push(format!("{column} = ?"));
                params.push(Sql::Text(value));
            }
        }
        let clause = clauses.join(" OR ");
        Ok((
            if term.op == "!=" {
                format!("NOT ({clause})")
            } else {
                clause
            },
            params,
        ))
    })
}

pub fn upper_text(column: &str) -> Compiler {
    let inner = text(column);
    Box::new(move |term| {
        inner(&Term {
            value: term.value.to_uppercase(),
            ..term.clone()
        })
    })
}

fn compare(op: &str) -> &'static str {
    match op {
        ":" => "=",
        "!=" => "!=",
        ">" => ">",
        ">=" => ">=",
        "<" => "<",
        _ => "<=",
    }
}

/// Python's float(): what it accepts beyond Rust's f64 (surrounding spaces, `_` between digits) is rare here.
fn py_float(value: &str) -> Option<f64> {
    value.trim().parse::<f64>().ok()
}

fn number_with(column: &str, parse_value: fn(&str) -> Option<f64>, label: String) -> Compiler {
    let column = column.to_owned();
    Box::new(move |term| {
        let raw = if term.op == ":" || term.op == "!=" {
            values(term)
        } else {
            vec![term.value.clone()]
        };
        let parsed: Option<Vec<f64>> = raw.iter().map(|value| parse_value(value)).collect();
        let Some(parsed) = parsed else {
            return Err(SearchError(format!(
                "{} expects {label}, got {}",
                key(term),
                py_repr(&term.value)
            )));
        };
        let params: Vec<Sql> = parsed.into_iter().map(Sql::Real).collect();
        if params.len() > 1 {
            let marks = vec!["?"; params.len()].join(", ");
            let operator = if term.op == "!=" { "NOT IN" } else { "IN" };
            return Ok((format!("{column} {operator} ({marks})"), params));
        }
        Ok((format!("{column} {} ?", compare(&term.op)), params))
    })
}

pub fn number(column: &str) -> Compiler {
    number_with(column, py_float, "a number".into())
}

/// `200ms`, `1.5s`, `300us`; a bare number means milliseconds.
pub fn parse_duration_us(value: &str) -> Option<f64> {
    let found = DURATION.captures(value)?;
    let unit = match found.name("unit").map(|unit| unit.as_str()) {
        Some("us" | "µs") => 1.0,
        Some("s") => 1_000_000.0,
        _ => 1000.0,
    };
    found["number"]
        .parse::<f64>()
        .ok()
        .map(|number| number * unit)
}

pub fn duration(column: &str) -> Compiler {
    number_with(
        column,
        parse_duration_us,
        "a duration like 200ms or 1.5s".into(),
    )
}

pub fn level(column: &str) -> Compiler {
    fn parse_level(value: &str) -> Option<f64> {
        let lower = value.to_lowercase();
        LEVELS
            .iter()
            .find(|(name, _)| *name == lower)
            .map(|(_, number)| *number as f64)
    }
    let names: Vec<&str> = LEVELS.iter().map(|(name, _)| *name).collect();
    number_with(
        column,
        parse_level,
        format!("a level ({})", names.join(", ")),
    )
}

/// The `since:` and `until:` of a query, in epoch µs: the last of each wins, as in a dict built from them.
pub fn period(query: &str, now_us: i64) -> (Option<i64>, Option<i64>) {
    let bound = |name: &str| {
        parse(query)
            .into_iter()
            .rev()
            .filter(|term| term.key.as_deref() == Some(name) && term.op == ":")
            .find_map(|term| parse_time_us(&term.value, now_us))
    };
    (bound("since"), bound("until"))
}

/// `15m` / `2h` / `1d` ago, or an ISO date-time (local time without an offset); epoch µs.
pub fn parse_time_us(value: &str, now_us: i64) -> Option<i64> {
    if let Some(found) = AGO.captures(value) {
        let unit: i64 = match &found["unit"] {
            "s" => 1_000_000,
            "m" => 60_000_000,
            "h" => 3_600_000_000,
            _ => 86_400_000_000,
        };
        return Some(now_us - found["number"].parse::<i64>().ok()? * unit);
    }
    let text = value.replace(' ', "T");
    if let Ok(moment) = DateTime::parse_from_rfc3339(&text.replace('z', "Z")) {
        return Some(moment.timestamp_micros());
    }
    for format in [
        "%Y-%m-%dT%H:%M:%S%.f%:z",
        "%Y-%m-%dT%H:%M%:z",
        "%Y-%m-%dT%H%:z",
    ] {
        if let Ok(moment) = DateTime::parse_from_str(&text, format) {
            return Some(moment.timestamp_micros());
        }
    }
    let naive = [
        "%Y-%m-%dT%H:%M:%S%.f",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%dT%H:%M",
        "%Y-%m-%dT%H",
    ]
    .iter()
    .find_map(|format| NaiveDateTime::parse_from_str(&text, format).ok())
    .or_else(|| {
        NaiveDate::parse_from_str(&text, "%Y-%m-%d")
            .ok()
            .and_then(|date| date.and_hms_opt(0, 0, 0))
    })?;
    Local
        .from_local_datetime(&naive)
        .earliest()
        .map(|moment| moment.timestamp_micros())
}

pub fn now_us() -> i64 {
    chrono::Utc::now().timestamp_micros()
}

/// `since:` (inclusive) and `until:` (exclusive) bounds on an epoch-µs column.
pub fn time_bound(column: &str, upper: bool) -> Compiler {
    let column = column.to_owned();
    Box::new(move |term| {
        if term.op != ":" {
            return Err(SearchError(format!(
                "{0} supports only :, like {0}:15m",
                key(term)
            )));
        }
        let Some(value) = parse_time_us(&term.value, now_us()) else {
            return Err(SearchError(format!(
                "{} expects a time like 15m, 2h, 1d or 2026-10-07T13:30, got {}",
                key(term),
                py_repr(&term.value)
            )));
        };
        Ok((
            format!("{column} {} ?", if upper { "<" } else { ">=" }),
            vec![Sql::Integer(value)],
        ))
    })
}

pub type FreeText = Box<dyn Fn(&str) -> (String, Vec<Sql>) + Send + Sync>;
/// A filter that narrows another filter of the search, compiled with that filter's last `:` term (None without one).
pub type Narrowing = Box<dyn Fn(Option<&Term>, &Term) -> Clause + Send + Sync>;
pub type Prefixed = Box<dyn Fn(&str) -> Compiler + Send + Sync>;

/// Searchable fields of one resource and how free text is matched.
pub struct Schema {
    pub fields: BTreeMap<String, Compiler>,
    pub free_text: FreeText,
    /// "extra." -> compiler for any key under that prefix (fields spelled "extra.*").
    pub prefixed: Vec<(String, Prefixed)>,
    /// A field that narrows another (`call_duration` narrows `call`: that call slower than the value), by its name:
    /// the one it narrows, and how. It is still declared with a compiler of its own, for a search without the other.
    pub narrowing: Vec<(String, String, Narrowing)>,
}

/// A resource's declared fields (from the spec): name -> type.
fn declared(resource: &str) -> Vec<(String, String)> {
    let spec: Value = serde_json::from_str(SPEC).expect("schema/search.json is JSON");
    spec[resource]
        .as_object()
        .map(|fields| {
            fields
                .iter()
                .map(|(name, field)| {
                    (
                        name.clone(),
                        field["type"].as_str().unwrap_or("").to_owned(),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Bind a resource's portable fields to storage columns; `custom` covers fields that need more than a column.
pub fn schema_for(
    resource: &str,
    columns: &[(&str, &str)],
    free_text: FreeText,
    mut custom: Vec<(&str, Compiler)>,
    mut prefixed: Vec<(&str, Prefixed)>,
) -> Schema {
    let mut fields = BTreeMap::new();
    let mut prefixes = Vec::new();
    for (name, kind) in declared(resource) {
        if let Some(stem) = name.strip_suffix('*') {
            let at = prefixed
                .iter()
                .position(|(declared, _)| *declared == name)
                .expect("a prefixed compiler");
            prefixes.push((stem.to_owned(), prefixed.remove(at).1));
        } else if let Some(at) = custom.iter().position(|(declared, _)| *declared == name) {
            fields.insert(name, custom.remove(at).1);
        } else {
            let column = columns
                .iter()
                .find(|(declared, _)| *declared == name)
                .map(|(_, column)| *column);
            let column = column
                .unwrap_or_else(|| panic!("{resource}.{name} needs a column or a custom compiler"));
            let compiler = match kind.as_str() {
                "time" => time_bound(column, name == "until"),
                "number" => number(column),
                "duration" => duration(column),
                "level" => level(column),
                _ => text(column),
            };
            fields.insert(name, compiler);
        }
    }
    Schema {
        fields,
        free_text,
        prefixed: prefixes,
        narrowing: Vec::new(),
    }
}

pub fn compile_where(query: &str, schema: &Schema) -> Result<(String, Vec<Sql>), SearchError> {
    let mut clauses = Vec::new();
    let mut params = Vec::new();
    let mut words = Vec::new();
    let terms = parse(query);
    for term in &terms {
        let Some(name) = term.key.clone() else {
            words.push(term.value.clone());
            continue;
        };
        let narrowed = schema
            .narrowing
            .iter()
            .find(|(field, _, _)| *field == name)
            .and_then(|(_, other, narrowing)| {
                let other = terms
                    .iter()
                    .rev()
                    .find(|each| each.key.as_deref() == Some(other.as_str()) && each.op == ":")?;
                Some((other, narrowing))
            });
        let clause = if let Some((other, narrowing)) = narrowed {
            narrowing(Some(other), term)?
        } else if let Some(compiler) = schema.fields.get(&name) {
            compiler(term)?
        } else if let Some((_, factory)) = schema
            .prefixed
            .iter()
            .find(|(prefix, _)| name.starts_with(prefix.as_str()) && name.len() > prefix.len())
        {
            factory(&name)(term)?
        } else {
            let known: Vec<&str> = schema.fields.keys().map(String::as_str).collect();
            return Err(SearchError(format!(
                "Unknown filter {}. Use one of: {}",
                py_repr(&name),
                known.join(", ")
            )));
        };
        clauses.push(clause.0);
        params.extend(clause.1);
    }
    if !words.is_empty() {
        let (clause, values) = (schema.free_text)(&words.join(" "));
        clauses.push(clause);
        params.extend(values);
    }
    let condition = clauses
        .iter()
        .map(|clause| format!("({clause})"))
        .collect::<Vec<_>>()
        .join(" AND ");
    Ok((
        if condition.is_empty() {
            "1 = 1".into()
        } else {
            condition
        },
        params,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_period_is_its_last_since_and_until() {
        let now = 1_000_000_000_000;
        assert_eq!(
            period("since:15m route:/api/*", now),
            (Some(now - 900_000_000), None)
        );
        assert_eq!(
            period("since:1h since:15m until:5m", now),
            (Some(now - 900_000_000), Some(now - 300_000_000))
        );
        assert_eq!(period("route:/api/* since>15m", now), (None, None));
    }

    #[test]
    fn a_quoted_value_keeps_its_escaped_quotes() {
        assert_eq!(
            parse(r#"kind:page name:"/ › click \"Save\"" "a \\ b""#),
            vec![
                Term {
                    key: Some("kind".into()),
                    op: ":".into(),
                    value: "page".into()
                },
                Term {
                    key: Some("name".into()),
                    op: ":".into(),
                    value: r#"/ › click "Save""#.into()
                },
                Term {
                    key: None,
                    op: ":".into(),
                    value: r"a \ b".into()
                },
            ]
        );
    }

    #[test]
    fn parses_filters_and_quoted_text() {
        assert_eq!(
            parse(r#"route:/api/* status>=500 "connection refused""#),
            vec![
                Term {
                    key: Some("route".into()),
                    op: ":".into(),
                    value: "/api/*".into()
                },
                Term {
                    key: Some("status".into()),
                    op: ">=".into(),
                    value: "500".into()
                },
                Term {
                    key: None,
                    op: ":".into(),
                    value: "connection refused".into()
                },
            ]
        );
    }

    #[test]
    fn a_key_s_filters_split_off_as_typed() {
        assert_eq!(
            split_off(
                r#"duration>500ms route:"/a b" duration<=2s slow"#,
                "duration"
            ),
            (
                r#"route:"/a b" slow"#.into(),
                "duration>500ms duration<=2s".into()
            )
        );

        assert_eq!(
            split_off("system:sql", "duration"),
            ("system:sql".into(), String::new())
        );
    }

    #[test]
    fn durations_and_times() {
        assert_eq!(parse_duration_us("200ms"), Some(200_000.0));
        assert_eq!(parse_duration_us("1.5s"), Some(1_500_000.0));
        assert_eq!(parse_duration_us("300"), Some(300_000.0));
        assert_eq!(
            parse_time_us("15m", 1_000_000_000),
            Some(1_000_000_000 - 900_000_000)
        );
        assert_eq!(
            parse_time_us("2026-10-07T13:30:00+00:00", 0),
            Some(1_791_379_800_000_000)
        );
        assert!(parse_time_us("yesterday", 0).is_none());
    }

    #[test]
    fn a_level_compares_by_its_rank() {
        let level = level("level_no");
        let term = |op: &str, value: &str| Term {
            key: Some("level".into()),
            op: op.into(),
            value: value.into(),
        };
        assert_eq!(
            level(&term(">=", "warning")).unwrap(),
            ("level_no >= ?".into(), vec![Sql::Real(30.0)])
        );
        assert_eq!(
            level(&term(">", "ERROR")).unwrap(),
            ("level_no > ?".into(), vec![Sql::Real(40.0)])
        );
        assert_eq!(
            level(&term(":", "warning,error")).unwrap(),
            (
                "level_no IN (?, ?)".into(),
                vec![Sql::Real(30.0), Sql::Real(40.0)]
            )
        );
        assert_eq!(
            level(&term(">=", "loud")).unwrap_err(),
            SearchError(
                "level expects a level (debug, info, warning, error, critical), got 'loud'".into()
            )
        );
    }

    #[test]
    fn repr_quotes_like_python() {
        assert_eq!(py_repr("abc"), "'abc'");
        assert_eq!(py_repr("it's"), "\"it's\"");
    }
}
