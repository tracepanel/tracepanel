//! The search schemas of the console's lists: which filters each one takes and how they compile to SQL.

use super::*;

pub(crate) const OPERATION: &str = "json_extract(doc, '$.attrs.\"graphql.operation\"')";
pub(crate) const QUEUE: &str = "json_extract(doc, '$.attrs.\"task.queue\"')";
pub(crate) const STATE: &str = "json_extract(doc, '$.attrs.\"task.state\"')";
pub(crate) const SYSTEM: &str = "json_extract(doc, '$.attrs.\"task.system\"')";

pub(crate) fn has(term: &Term) -> search::Clause {
    if term.op != ":" {
        return Err(SearchError("has supports only ':'".into()));
    }
    match term.value.as_str() {
        "error" => Ok(("errors > 0 OR issue_kinds LIKE '%,error,%'".into(), vec![])),
        "logs" => Ok(("logs > 0".into(), vec![])),
        "issues" => Ok(("issues > 0".into(), vec![])),
        "mail" => Ok(("mails > 0".into(), vec![])),
        "n+1" | "duplicates" | "slow-sql" | "slow-http" | "long-transaction" | "in-transaction"
        | "htmx" => {
            Ok(("issue_kinds LIKE ?".into(), vec![Sql::Text(format!("%,{},%", term.value))]))
        }
        _ => Err(SearchError(
            "has expects one of: n+1, duplicates, slow-sql, slow-http, long-transaction, in-transaction, htmx, error, \
             issues, logs, mail"
                .into(),
        )),
    }
}

pub(crate) fn contains(column: &'static str) -> Compiler {
    Box::new(move |term| {
        Ok((
            format!("{column} LIKE ?"),
            vec![Sql::Text(format!("%,{},%", term.value))],
        ))
    })
}

/// Rows of a table that keeps its trace's id (`column`): those whose trace an app (service.name) recorded.
fn of_service(column: &'static str) -> Compiler {
    let service = search::text("service");
    Box::new(move |term| {
        let (clause, params) = service(term)?;
        Ok((
            format!("{column} IN (SELECT id FROM traces WHERE {clause})"),
            params,
        ))
    })
}

/// Issues seen in a trace that matches `filter` (a filter on the traces table).
fn in_issue_traces(filter: Compiler) -> Compiler {
    Box::new(move |term| {
        let (clause, params) = filter(term)?;
        Ok((
            format!(
                "fingerprint IN (SELECT issue_traces.fingerprint FROM issue_traces \
                 JOIN traces ON traces.id = issue_traces.trace_id WHERE {clause})"
            ),
            params,
        ))
    })
}

pub(crate) fn trace_search() -> search::Schema {
    let task_name = search::text("name");
    search::schema_for(
        "traces",
        &[
            ("kind", "kind"),
            ("route", "route"),
            ("path", "path"),
            ("view", "view"),
            ("status", "http_status"),
            ("duration", "duration"),
            ("queries", "queries"),
            ("user", "user_id"),
            ("trace", "id"),
            ("name", "name"),
            ("service", "service"),
            ("since", "start"),
            ("until", "start"),
        ],
        Box::new(|words| {
            let pattern = format!("%{}%", search::like(words));
            (
                "name LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\'".into(),
                vec![Sql::Text(pattern.clone()), Sql::Text(pattern)],
            )
        }),
        vec![
            ("method", search::upper_text("method")),
            ("has", Box::new(has)),
            (
                "query",
                Box::new(|term| {
                    Ok((
                        "id IN (SELECT trace_id FROM ops WHERE key = ? AND system = 'sql')".into(),
                        vec![Sql::Text(term.value.clone())],
                    ))
                }),
            ),
            (
                "call",
                Box::new(|term| {
                    Ok((
                        "id IN (SELECT trace_id FROM ops WHERE key = ? AND system = 'http')".into(),
                        vec![Sql::Text(term.value.clone())],
                    ))
                }),
            ),
            (
                "redis_call",
                Box::new(|term| {
                    Ok((
                        "id IN (SELECT trace_id FROM ops WHERE key = ? AND system = 'redis')"
                            .into(),
                        vec![Sql::Text(term.value.clone())],
                    ))
                }),
            ),
            (
                "cache_call",
                Box::new(|term| {
                    Ok((
                        "id IN (SELECT trace_id FROM ops WHERE key = ? AND system = 'cache')"
                            .into(),
                        vec![Sql::Text(term.value.clone())],
                    ))
                }),
            ),
            (
                "op",
                Box::new(|term| {
                    Ok((
                        "id IN (SELECT trace_id FROM ops WHERE key = ?)".into(),
                        vec![Sql::Text(term.value.clone())],
                    ))
                }),
            ),
            (
                "peer",
                Box::new(|term| {
                    Ok((
                        "id IN (SELECT trace_id FROM peers WHERE peer = ?)".into(),
                        vec![Sql::Text(term.value.clone())],
                    ))
                }),
            ),
            ("db", contains("db_aliases")),
            (
                "task",
                Box::new(move |term| {
                    let (clause, params) = task_name(term)?;
                    Ok((format!("kind = 'task' AND ({clause})"), params))
                }),
            ),
            ("operation", search::text(OPERATION)),
            ("queue", search::text(QUEUE)),
            ("state", search::upper_text(STATE)),
            ("system", search::text(SYSTEM)),
            ("cache", contains("cache_aliases")),
        ],
        vec![],
    )
}

pub(crate) static TRACE_SEARCH: std::sync::LazyLock<search::Schema> =
    std::sync::LazyLock::new(trace_search);

pub(crate) fn log_search(fts: bool) -> search::Schema {
    search::schema_for(
        "logs",
        &[
            ("level", "logs.level_no"),
            ("logger", "logs.logger"),
            ("trace", "logs.trace_id"),
            ("route", "traces.route"),
            ("path", "traces.path"),
            ("user", "traces.user_id"),
            ("service", "traces.service"),
            ("since", "logs.time"),
            ("until", "logs.time"),
        ],
        Box::new(move |words| {
            if fts {
                // Each word as a quoted prefix token: safe against FTS syntax, matches as you type.
                let tokens: Vec<String> = words
                    .split_whitespace()
                    .filter(|word| !word.trim_matches('"').is_empty())
                    .map(|word| format!("\"{}\"*", word.replace('"', "")))
                    .collect();
                (
                    "logs.id IN (SELECT rowid FROM logs_fts WHERE logs_fts MATCH ?)".into(),
                    vec![Sql::Text(tokens.join(" "))],
                )
            } else {
                (
                    "logs.message LIKE ? ESCAPE '\\'".into(),
                    vec![Sql::Text(format!("%{}%", search::like(words)))],
                )
            }
        }),
        vec![],
        // Keys come from the query grammar ([a-z0-9_.] only), so they are safe inside the JSON path.
        vec![(
            "extra.*",
            Box::new(|key: &str| {
                search::text(&format!(
                    "CAST(json_extract(logs.attrs, '$.\"{key}\"') AS TEXT)"
                ))
            }),
        )],
    )
}

/// `failed:true` (or `failed:false`): calls whose span failed, on every list of calls.
fn failed(term: &Term) -> search::Clause {
    if term.op != ":" {
        return Err(SearchError("failed supports only ':'".into()));
    }
    match term.value.to_lowercase().as_str() {
        "true" | "yes" | "1" => Ok(("error = 1".into(), vec![])),
        "false" | "no" | "0" => Ok(("error = 0".into(), vec![])),
        _ => Err(SearchError("failed expects true or false".into())),
    }
}

/// `term` with its value in lower case: cache ops are spelled as the cache API names them (`get`, `set_many`).
fn lower_text(column: &str) -> Compiler {
    let inner = search::text(column);
    Box::new(move |term| {
        inner(&Term {
            value: term.value.to_lowercase(),
            ..term.clone()
        })
    })
}

/// Free text over some of a list's columns: any of them containing the words.
fn free_text(columns: &'static [&'static str]) -> search::FreeText {
    Box::new(move |words| {
        let pattern = Sql::Text(format!("%{}%", search::like(words)));
        let clause = columns
            .iter()
            .map(|column| format!("{column} LIKE ? ESCAPE '\\'"))
            .collect::<Vec<_>>()
            .join(" OR ");
        (clause, vec![pattern; columns.len()])
    })
}

// Every list of operations takes the same filters over the `ops` table: the time, the app, the target (`target:`, as
// `db:` or `host:` too), the operation (`op:`, any case), `failed:`, and the key a trace search links with. The
// `ops` list takes `system:` and `family:`; Redis's `via:` (whether the app ran a command itself, or a cache or a task
// queue did for it) works on any. The Database, HTTP calls, Redis and Cache lists keep their own spelling of the same
// fields (`query:`, `call:`, `redis_call:`, `cache_call:` for the key; `method:` for HTTP's op).

pub(crate) fn ops_search() -> search::Schema {
    search::schema_for(
        "ops",
        &[
            ("system", "system"),
            ("family", "family"),
            ("target", "target"),
            ("db", "target"),
            ("host", "target"),
            ("key", "key"),
            ("since", "start"),
            ("until", "start"),
        ],
        free_text(&["template", "name", "statement", "target"]),
        vec![
            ("op", lower_text("lower(op)")),
            ("via", lower_text("via")),
            ("failed", Box::new(failed)),
            ("service", of_service("trace_id")),
        ],
        vec![],
    )
}

pub(crate) static OPS_SEARCH: std::sync::LazyLock<search::Schema> =
    std::sync::LazyLock::new(ops_search);

pub(crate) fn query_search() -> search::Schema {
    search::schema_for(
        "queries",
        &[
            ("query", "key"),
            ("db", "target"),
            ("since", "start"),
            ("until", "start"),
        ],
        free_text(&["template"]),
        vec![
            (
                "table",
                Box::new(|term| {
                    Ok((
                        "name LIKE ?".into(),
                        vec![Sql::Text(format!("% {}", term.value))],
                    ))
                }),
            ),
            ("op", search::upper_text("op")),
            ("failed", Box::new(failed)),
            ("service", of_service("trace_id")),
        ],
        vec![],
    )
}

pub(crate) static QUERY_SEARCH: std::sync::LazyLock<search::Schema> =
    std::sync::LazyLock::new(query_search);

pub(crate) fn call_search() -> search::Schema {
    search::schema_for(
        "calls",
        &[("call", "key"), ("since", "start"), ("until", "start")],
        free_text(&["template", "target"]),
        vec![
            ("host", search::text("target")),
            ("op", search::upper_text("op")),
            ("method", search::upper_text("op")),
            ("failed", Box::new(failed)),
            ("service", of_service("trace_id")),
        ],
        vec![],
    )
}

pub(crate) static CALL_SEARCH: std::sync::LazyLock<search::Schema> =
    std::sync::LazyLock::new(call_search);

pub(crate) fn redis_search() -> search::Schema {
    search::schema_for(
        "redis",
        &[
            ("redis_call", "key"),
            ("db", "target"),
            ("since", "start"),
            ("until", "start"),
        ],
        free_text(&["template", "op"]),
        vec![
            ("op", search::upper_text("op")),
            ("via", lower_text("via")),
            ("failed", Box::new(failed)),
            ("service", of_service("trace_id")),
        ],
        vec![],
    )
}

pub(crate) static REDIS_SEARCH: std::sync::LazyLock<search::Schema> =
    std::sync::LazyLock::new(redis_search);

pub(crate) fn cache_search() -> search::Schema {
    search::schema_for(
        "cache",
        &[
            ("cache_call", "key"),
            ("db", "target"),
            ("since", "start"),
            ("until", "start"),
        ],
        free_text(&["template", "op"]),
        vec![
            ("op", lower_text("op")),
            ("failed", Box::new(failed)),
            ("service", of_service("trace_id")),
        ],
        vec![],
    )
}

pub(crate) static CACHE_SEARCH: std::sync::LazyLock<search::Schema> =
    std::sync::LazyLock::new(cache_search);

pub(crate) fn mail_search() -> search::Schema {
    search::schema_for(
        "mails",
        &[
            ("from", "mails.sender"),
            ("since", "mails.time"),
            ("until", "mails.time"),
        ],
        Box::new(|words| {
            let pattern = Sql::Text(format!("%{}%", search::like(words)));
            (
                "mails.subject LIKE ? ESCAPE '\\' OR mails.recipients LIKE ? ESCAPE '\\'".into(),
                vec![pattern.clone(), pattern],
            )
        }),
        vec![
            (
                "to",
                Box::new(|term| {
                    Ok((
                        "mails.recipients LIKE ? ESCAPE '\\'".into(),
                        vec![Sql::Text(format!("%,{},%", search::like(&term.value)))],
                    ))
                }),
            ),
            ("service", of_service("mails.trace_id")),
        ],
        vec![],
    )
}

pub(crate) fn issue_search() -> search::Schema {
    let route = search::text("traces.route");
    let service = search::text("traces.service");
    search::schema_for(
        "issues",
        &[
            ("kind", "kind"),
            ("since", "last_seen"),
            ("until", "last_seen"),
        ],
        Box::new(|words| {
            let pattern = Sql::Text(format!("%{}%", search::like(words)));
            (
                "title LIKE ? ESCAPE '\\' OR culprit LIKE ? ESCAPE '\\'".into(),
                vec![pattern.clone(), pattern],
            )
        }),
        vec![
            ("route", in_issue_traces(route)),
            ("service", in_issue_traces(service)),
        ],
        vec![],
    )
}

pub(crate) fn service_search() -> search::Schema {
    search::schema_for(
        "services",
        &[
            ("kind", "kind"),
            ("system", "system"),
            ("role", "role"),
            ("service", "service"),
            ("since", "start"),
            ("until", "start"),
        ],
        Box::new(|words| {
            let pattern = Sql::Text(format!("%{}%", search::like(words)));
            (
                "(peer LIKE ? ESCAPE '\\' OR alias LIKE ? ESCAPE '\\')".into(),
                vec![pattern.clone(), pattern],
            )
        }),
        vec![],
        vec![],
    )
}

pub(crate) const SERVICE_ROLE: &str = "json_extract(doc, '$.attrs.\"service.role\"')";
pub(crate) const LANGUAGE: &str = "json_extract(doc, '$.attrs.\"telemetry.sdk.language\"')";

/// The services search, read against the traces: the app itself is a service too, of kind `app`, whose system is
/// its language. The same filters then keep or drop it as they do a database.
pub(crate) fn app_search() -> search::Schema {
    search::schema_for(
        "services",
        &[
            ("kind", "'app'"),
            ("system", LANGUAGE),
            ("role", SERVICE_ROLE),
            ("service", "service"),
            ("since", "start"),
            ("until", "start"),
        ],
        Box::new(|words| {
            (
                "service LIKE ? ESCAPE '\\'".into(),
                vec![Sql::Text(format!("%{}%", search::like(words)))],
            )
        }),
        vec![],
        vec![],
    )
}

pub(crate) static APP_SEARCH: std::sync::LazyLock<search::Schema> =
    std::sync::LazyLock::new(app_search);
pub(crate) static MAIL_SEARCH: std::sync::LazyLock<search::Schema> =
    std::sync::LazyLock::new(mail_search);
pub(crate) static ISSUE_SEARCH: std::sync::LazyLock<search::Schema> =
    std::sync::LazyLock::new(issue_search);
pub(crate) static SERVICE_SEARCH: std::sync::LazyLock<search::Schema> =
    std::sync::LazyLock::new(service_search);
