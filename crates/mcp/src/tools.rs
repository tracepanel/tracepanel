//! The tools: what an AI coding agent asks of the store, each answered as compact text (`compact`). Read only.

use crate::Server;
use crate::compact::{self, Focus, ago, fit, trace_line};
use crate::profile::{self, Kind};
use serde_json::{Value, json};
use std::time::{Duration, Instant};
use tracepanel_store_local::{ReadError, Selection, log_summary, no_remote, search};

const SEARCH: &str = "Search: free text and filters, e.g. `route:/api/* status>=500`, `has:n+1 duration>200ms`, \
    `kind:task state:FAILURE since:1h`. An unknown filter's error lists the known ones.";

/// The tools' definitions, as `tools/list` returns them.
pub(crate) fn list() -> Value {
    let query = |what: &str| json!({"type": "string", "description": format!("{what} {SEARCH}")});
    let limit = |default: i64, most: i64| json!({"type": "integer", "minimum": 1, "maximum": most, "default": default});
    let tools = [
        (
            "find_traces",
            "Find traces",
            "Recent requests, tasks and commands the app ran, newest first: what each was, its time, SQL and issues. \
             Start here to find the request you just made.",
            json!({"query": query("Which traces; empty for all."), "limit": limit(10, 50)}),
            vec![],
        ),
        (
            "get_trace",
            "Get a trace",
            "One trace, compact: its issues (N+1, duplicate and slow queries, errors…) with where in the code and how to \
             fix them, the error with its stack, the call tree with repeats folded, warnings, related tasks and whether it was profiled.",
            json!({
                "id": {"type": "string", "description": "The trace's id."},
                "focus": {
                    "type": "string",
                    "enum": ["issues", "tree", "sql", "logs"],
                    "default": "issues",
                    "description": "issues: the branches with issues, errors and most of the time; tree: the whole \
                                    call tree; sql: every statement, grouped; logs: every log record.",
                },
            }),
            vec!["id"],
        ),
        (
            "get_profile",
            "Get a profile",
            "Where a profiled trace's time went in code (cpu: functions by self and total time, the hottest paths, \
             waiting) or its memory (memory: peak, kept, the top allocation sites), with file:line. To profile a \
             request, send it with an `X-Tracepanel-Profile: 1` header (`memory` for its memory too).",
            json!({
                "id": {"type": "string", "description": "The trace's id."},
                "kind": {"type": "string", "enum": ["cpu", "memory"], "default": "cpu"},
                "top": {"type": "integer", "minimum": 1, "maximum": 50, "default": 10, "description": "Functions or sites listed."},
            }),
            vec!["id"],
        ),
        (
            "wait_for_trace",
            "Wait for a trace",
            "Waits for the next trace that matches, recorded after `after` (or after this call), and returns it as \
             get_trace does. Make the request (curl, a test) while waiting, then check what it did.",
            json!({
                "query": query("Which trace, e.g. `route:/api/orders`; empty for any."),
                "after": {"type": "string", "description": "A trace id: only traces recorded after it."},
                "timeout_s": {"type": "integer", "minimum": 1, "maximum": 120, "default": 30},
            }),
            vec![],
        ),
        (
            "compare_traces",
            "Compare two traces",
            "What changed between two traces of the same thing, e.g. before and after a fix: time, SQL, statements, \
             issues fixed and new, and with profiles the functions' self time and memory.",
            json!({
                "before": {"type": "string", "description": "The earlier trace's id."},
                "after": {"type": "string", "description": "The later trace's id."},
            }),
            vec!["before", "after"],
        ),
        (
            "list_issues",
            "List issues",
            "The project's issues, grouped as one per place in the code: N+1, duplicate and slow queries, long \
             transactions, work before commit, htmx errors and exceptions; most recent first.",
            json!({"query": query("Which issues, e.g. `kind:n+1`; empty for all."), "limit": limit(20, 100)}),
            vec![],
        ),
        (
            "get_issue",
            "Get an issue",
            "One issue: where, how to fix it, how often, on which endpoints, and its latest traces.",
            json!({"fingerprint": {"type": "string", "description": "The issue's fingerprint."}}),
            vec!["fingerprint"],
        ),
        (
            "list_endpoints",
            "List endpoints",
            "HTTP endpoints by traffic: calls, p50 and p95 time, SQL per call, errors and issues.",
            json!({"query": query("Which traces count; empty for all."), "limit": limit(20, 100)}),
            vec![],
        ),
        (
            "list_calls",
            "List calls",
            "Calls to databases, Redis, caches, HTTP services and other systems across all traces, grouped by \
             statement or operation, heaviest first: how often, how many per trace, total and slowest time, and \
             where in the code.",
            json!({"query": query("Which calls, e.g. `system:sql op:select` or `system:redis failed:true`; empty for all."), "limit": limit(20, 100)}),
            vec![],
        ),
        (
            "search_logs",
            "Search logs",
            "Log records, newest first, with their level, logger and trace. With `trace`: that trace's records and \
             those of every trace down its chain of calls (the services its calls reached, theirs in turn), in time \
             order on its clock with each record's app, added up by level and app; `span` narrows to what is under \
             those spans (a span's own records, its children's and its calls' traces'), `only` to the spans' own.",
            json!({
                "query": query("Which records, e.g. `level>=warning logger:app.*`; empty for all. Not with `trace`."),
                "limit": limit(50, 200),
                "trace": {"type": "string", "description": "A trace's id: its records and its chain's."},
                "chain": {"type": "boolean", "default": true, "description": "With `trace`: false for the trace's own records only."},
                "span": {"type": "string", "description": "With `trace`: span ids (comma-separated) or a chain trace's id; what is under them."},
                "only": {"type": "boolean", "default": false, "description": "With `span`: the spans' own records, not those under them."},
            }),
            vec![],
        ),
    ];
    Value::Array(
        tools
            .into_iter()
            .map(|(name, title, description, properties, required)| {
                json!({
                    "name": name,
                    "title": title,
                    "description": description.split_whitespace().collect::<Vec<_>>().join(" "),
                    "inputSchema": {"type": "object", "properties": properties, "required": required, "additionalProperties": false},
                    "annotations": {"readOnlyHint": true, "openWorldHint": false},
                })
            })
            .collect(),
    )
}

/// A call that can't be answered: said to the model as the tool's result (`isError`), so it can correct itself.
pub(crate) struct Refusal(pub(crate) String);

impl From<ReadError> for Refusal {
    fn from(error: ReadError) -> Self {
        match error {
            ReadError::Search(message) => Self(message),
            ReadError::Store(error) => Self(format!("the store can't be read: {error}")),
        }
    }
}

impl From<tracepanel_store_local::Error> for Refusal {
    fn from(error: tracepanel_store_local::Error) -> Self {
        Self::from(ReadError::Store(error))
    }
}

fn string(args: &Value, key: &str) -> String {
    args.get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_owned()
}

fn number(args: &Value, key: &str, default: i64, most: i64) -> i64 {
    args.get(key)
        .and_then(Value::as_i64)
        .map_or(default, |value| value.clamp(1, most))
}

fn required(args: &Value, key: &str) -> Result<String, Refusal> {
    let value = string(args, key);
    if value.is_empty() {
        return Err(Refusal(format!("{key} is required")));
    }
    Ok(value)
}

/// A known tool's answer; `None` for a tool that isn't one.
pub(crate) fn call(server: &Server, name: &str, args: &Value) -> Option<Result<String, Refusal>> {
    let answer = match name {
        "find_traces" => find_traces(server, args),
        "get_trace" => get_trace(server, args),
        "get_profile" => get_profile(server, args),
        "wait_for_trace" => wait_for_trace(server, args),
        "compare_traces" => compare_traces(server, args),
        "list_issues" => list_issues(server, args),
        "get_issue" => get_issue(server, args),
        "list_endpoints" => list_endpoints(server, args),
        "list_calls" => list_calls(server, args),
        "search_logs" => search_logs(server, args),
        _ => return None,
    };
    Some(answer.map(fit))
}

fn store_ready(server: &Server) -> Result<(), Refusal> {
    if server.store.exists() {
        return Ok(());
    }
    Err(Refusal(format!(
        "No traces yet: {} has no store. Run the app with Tracepanel and make a request.",
        server.dir.display()
    )))
}

fn lines(header: String, rows: Vec<String>, empty: &str) -> String {
    if rows.is_empty() {
        return empty.to_owned();
    }
    format!("{header}\n{}", rows.join("\n"))
}

fn find_traces(server: &Server, args: &Value) -> Result<String, Refusal> {
    store_ready(server)?;
    let query = string(args, "query");
    let page = server
        .reader
        .search_traces(&query, number(args, "limit", 10, 50), None)?;
    let now = search::now_us();
    Ok(lines(
        format!("traces ({}, newest first):", page.items.len()),
        page.items.iter().map(|row| trace_line(row, now)).collect(),
        "No traces match.",
    ))
}

/// The trace as stored, or why not.
fn document(server: &Server, id: &str) -> Result<Value, Refusal> {
    store_ready(server)?;
    let raw = server
        .reader
        .get_trace(id)?
        .ok_or_else(|| Refusal(format!("No trace {id}: find_traces lists the recent ones.")))?;
    serde_json::from_str(&raw)
        .map_err(|error| Refusal(format!("trace {id} can't be read: {error}")))
}

fn shown(server: &Server, doc: &Value, focus: Focus) -> Result<String, Refusal> {
    let related = server.reader.related(compact::text(doc, "id"))?;
    let mut answer = compact::trace(doc, &related, focus, server.values, search::now_us());
    if let Some(chain) = chain_section(server, compact::text(doc, "id"))? {
        answer.push_str(&format!("\n\n{chain}"));
    }
    if let Some(console) = server.console_url() {
        answer.push_str(&format!(
            "\n\nconsole: {console}#/t/{}",
            compact::text(doc, "id")
        ));
    }
    Ok(answer)
}

fn get_trace(server: &Server, args: &Value) -> Result<String, Refusal> {
    let id = required(args, "id")?;
    let focus = match string(args, "focus").as_str() {
        "" => Focus::Issues,
        name => Focus::parse(name).ok_or_else(|| {
            Refusal(format!(
                "focus is one of issues, tree, sql, logs; not {name}"
            ))
        })?,
    };
    let doc = document(server, &id)?;
    shown(server, &doc, focus)
}

fn get_profile(server: &Server, args: &Value) -> Result<String, Refusal> {
    let id = required(args, "id")?;
    let kind = match string(args, "kind").as_str() {
        "" => Kind::Cpu,
        name => Kind::parse(name)
            .ok_or_else(|| Refusal(format!("kind is cpu or memory; not {name}")))?,
    };
    let doc = document(server, &id)?;
    let body =
        profile::profile(&doc, kind, number(args, "top", 10, 50) as usize).map_err(Refusal)?;
    let mut answer = format!("{id}  {}\n{body}", compact::trace_head(&doc));
    if let Some(console) = server.console_url() {
        answer.push_str(&format!("\n\nconsole: {console}#/t/{id}"));
    }
    Ok(answer)
}

fn wait_for_trace(server: &Server, args: &Value) -> Result<String, Refusal> {
    let query = string(args, "query");
    let after = string(args, "after");
    let since = if after.is_empty() {
        search::now_us()
    } else {
        compact::int(&document(server, &after)?, "start")
    };
    let timeout = Duration::from_secs(number(args, "timeout_s", 30, 120) as u64);
    let deadline = Instant::now() + timeout;
    loop {
        if server.store.exists() {
            let page = server.reader.search_traces(&query, 20, None)?;
            // The first one recorded after: the request that was made, not what followed it.
            let found = page
                .items
                .iter()
                .filter(|row| {
                    compact::int(row, "start") > since && compact::text(row, "id") != after
                })
                .min_by_key(|row| compact::int(row, "start"));
            if let Some(row) = found {
                let doc = document(server, compact::text(row, "id"))?;
                return shown(server, &doc, Focus::Issues);
            }
        }
        if Instant::now() >= deadline {
            let matching = if query.is_empty() {
                String::new()
            } else {
                format!(" matching `{query}`")
            };
            return Err(Refusal(format!(
                "No new trace{matching} in {} s. Is the app running with Tracepanel, and did the request reach it? \
                 find_traces shows what was recorded.",
                timeout.as_secs()
            )));
        }
        std::thread::sleep(server.poll);
    }
}

fn compare_traces(server: &Server, args: &Value) -> Result<String, Refusal> {
    let before = document(server, &required(args, "before")?)?;
    let after = document(server, &required(args, "after")?)?;
    Ok(compact::compare(&before, &after))
}

fn list_issues(server: &Server, args: &Value) -> Result<String, Refusal> {
    store_ready(server)?;
    let rows = server
        .reader
        .list_issues(&string(args, "query"), number(args, "limit", 20, 100))?;
    let now = search::now_us();
    Ok(lines(
        format!("issues ({}, most recent first):", rows.len()),
        rows.iter()
            .map(|row| compact::issue_lines(row, now))
            .collect(),
        "No issues.",
    ))
}

fn get_issue(server: &Server, args: &Value) -> Result<String, Refusal> {
    store_ready(server)?;
    let fingerprint = required(args, "fingerprint")?;
    let detail = server
        .reader
        .issue_detail(&fingerprint, "", 1, 10)?
        .ok_or_else(|| Refusal(format!("No issue {fingerprint}: list_issues lists them.")))?;
    let now = search::now_us();
    let traces: Vec<String> = detail
        .get("traces")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|row| format!("  {}", trace_line(row, now)))
        .collect();
    Ok(format!(
        "{}\nfirst seen {}\n\nlatest traces:\n{}",
        compact::issue_lines(&detail, now),
        ago(compact::int(&detail, "first_seen"), now),
        traces.join("\n")
    ))
}

fn list_endpoints(server: &Server, args: &Value) -> Result<String, Refusal> {
    store_ready(server)?;
    let rows = server
        .reader
        .list_endpoints(&string(args, "query"), number(args, "limit", 20, 100))?;
    let now = search::now_us();
    Ok(lines(
        format!("endpoints ({}, busiest first):", rows.len()),
        rows.iter()
            .map(|row| compact::endpoint_line(row, now))
            .collect(),
        "No endpoints.",
    ))
}

fn list_calls(server: &Server, args: &Value) -> Result<String, Refusal> {
    store_ready(server)?;
    let rows = server
        .reader
        .list_calls(&string(args, "query"), number(args, "limit", 20, 100))?;
    Ok(lines(
        format!("calls ({}, heaviest first):", rows.len()),
        rows.iter().map(compact::call_lines).collect(),
        "No calls.",
    ))
}

fn search_logs(server: &Server, args: &Value) -> Result<String, Refusal> {
    store_ready(server)?;
    if !string(args, "trace").is_empty() {
        return trace_logs(server, args);
    }
    let page =
        server
            .reader
            .search_logs(&string(args, "query"), number(args, "limit", 50, 200), None)?;
    let now = search::now_us();
    Ok(lines(
        format!("logs ({}, newest first):", page.items.len()),
        page.items
            .iter()
            .map(|row| compact::log_line(row, now))
            .collect(),
        "No log records match.",
    ))
}

fn flag(args: &Value, key: &str, default: bool) -> bool {
    args.get(key).and_then(Value::as_bool).unwrap_or(default)
}

/// A trace's records, its chain's with `chain`, under `span`: in time order, added up first.
fn trace_logs(server: &Server, args: &Value) -> Result<String, Refusal> {
    let id = string(args, "trace");
    let chain = server
        .reader
        .chain(&id, flag(args, "chain", true), &no_remote)?
        .ok_or_else(|| Refusal(format!("No trace {id}: find_traces lists the recent ones.")))?;
    let selection = Selection {
        targets: string(args, "span")
            .split(',')
            .map(str::trim)
            .filter(|span| !span.is_empty())
            .map(str::to_owned)
            .collect(),
        only: flag(args, "only", false),
    };
    let scope = chain.select(&selection);
    let logs = scope.logs();
    let start = compact::int(&chain.members[0].doc, "start");
    let limit = number(args, "limit", 50, 200) as usize;
    let summary = log_summary(&logs, scope.window);
    let mut head = format!(
        "logs of {id}{}{} ({} in {}):",
        if chain.members.len() > 1 {
            " and its chain"
        } else {
            ""
        },
        if selection.targets.is_empty() {
            String::new()
        } else {
            format!(" under {}", selection.targets.join(","))
        },
        compact::count(logs.len() as i64, "record", "records"),
        compact::count(chain.members.len() as i64, "trace", "traces"),
    );
    if logs.is_empty() {
        return Ok(format!("{head}\nNo log records."));
    }
    head.push_str(&format!("\n{}", compact::scope_counts(&summary)));
    if !summary["first_error"].is_null() {
        head.push_str(&format!(
            "\nfirst error: {}",
            compact::scope_log_line(&summary["first_error"], start)
        ));
    }
    let more = if logs.len() > limit {
        format!(
            "\n… {} more: raise limit or narrow with span",
            logs.len() - limit
        )
    } else {
        String::new()
    };
    let rows: Vec<String> = logs
        .iter()
        .take(limit)
        .map(|log| compact::scope_log_line(log, start))
        .collect();
    Ok(format!("{head}\n{}{more}", rows.join("\n")))
}

/// The traces down a trace's chain of calls, when it has any: their apps, and their warnings and worse (the trace's
/// own are in its logs).
fn chain_section(server: &Server, id: &str) -> Result<Option<String>, Refusal> {
    let Some(chain) = server.reader.chain(id, true, &no_remote)? else {
        return Ok(None);
    };
    if chain.members.len() < 2 {
        return Ok(None);
    }
    let start = compact::int(&chain.members[0].doc, "start");
    let mut apps: Vec<&str> = Vec::new();
    for member in &chain.members[1..] {
        if !apps.contains(&member.app()) {
            apps.push(member.app());
        }
    }
    let loud: Vec<Value> = chain
        .select(&Selection::default())
        .logs()
        .into_iter()
        .filter(|log| {
            log["trace_id"] != id
                && matches!(
                    compact::text(log, "level"),
                    "warning" | "error" | "critical"
                )
        })
        .collect();
    let mut out = format!(
        "chain: {} down its calls ({}); logs → search_logs trace:{id}",
        compact::count(chain.members.len() as i64 - 1, "trace", "traces"),
        apps.join(", ")
    );
    if !loud.is_empty() {
        out.push_str(&format!("\ntheir warnings and worse ({}):", loud.len()));
        for log in loud.iter().take(10) {
            out.push_str(&format!("\n  {}", compact::scope_log_line(log, start)));
        }
    }
    Ok(Some(out))
}
