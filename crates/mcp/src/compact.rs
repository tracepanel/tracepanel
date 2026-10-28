//! What the model reads: traces, issues and lists as short text. A raw trace is mostly noise to a model (151 SQL
//! spans hide the one N+1), so repeats fold into one line, the call tree keeps the branches that matter, code is the
//! project's `path:line`, and an answer stays within a budget.
//!
//! Without `values` (the default) the answers carry the shape of the data, not the data: SQL without its parameters,
//! frames without their local variables. With it, variables whose names look secret are still masked.

use crate::profile;
use serde_json::Value;
use std::collections::{HashMap, HashSet};

/// The most an answer says (~4 000 tokens); the rest is cut, with a note.
pub(crate) const BUDGET: usize = 16_000;
/// Call tree lines, at most.
const TREE_LINES: usize = 80;
const STATEMENT: usize = 400;
const MESSAGE: usize = 300;

/// What `get_trace` shows of a trace besides its head and issues.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Focus {
    /// The branches with issues, errors and most of the time.
    Issues,
    /// The whole call tree, repeats folded.
    Tree,
    /// Every statement, grouped.
    Sql,
    /// Every log record.
    Logs,
}

impl Focus {
    pub(crate) fn parse(name: &str) -> Option<Self> {
        match name {
            "issues" => Some(Self::Issues),
            "tree" => Some(Self::Tree),
            "sql" => Some(Self::Sql),
            "logs" => Some(Self::Logs),
            _ => None,
        }
    }
}

pub(crate) fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

pub(crate) fn int(value: &Value, key: &str) -> i64 {
    value.get(key).and_then(Value::as_i64).unwrap_or(0)
}

/// Microseconds as a person reads them: `0.4 ms`, `27.6 ms`, `376 ms`, `7.9 s`; a second and up in seconds, as the
/// console says them.
pub(crate) fn ms(us: i64) -> String {
    let ms = us as f64 / 1000.0;
    if ms >= 1000.0 {
        format!("{:.1} s", ms / 1000.0)
    } else if ms >= 100.0 {
        format!("{ms:.0} ms")
    } else {
        format!("{ms:.1} ms")
    }
}

/// `1 call`, `3 calls`.
pub(crate) fn count(n: i64, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

pub(crate) fn ago(time: i64, now: i64) -> String {
    let seconds = (now - time).max(0) / 1_000_000;
    match seconds {
        0..60 => format!("{seconds}s ago"),
        60..3600 => format!("{}m ago", seconds / 60),
        3600..86400 => format!("{}h ago", seconds / 3600),
        _ => format!("{}d ago", seconds / 86400),
    }
}

/// At most `limit` characters, on one line.
pub(crate) fn short(value: &str, limit: usize) -> String {
    let line = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() <= limit {
        return line;
    }
    let cut: String = line.chars().take(limit).collect();
    format!("{cut}…")
}

/// An answer within the budget: past it, cut at a line, saying how much is left out.
pub(crate) fn fit(answer: String) -> String {
    if answer.len() <= BUDGET {
        return answer;
    }
    let mut end = BUDGET;
    while !answer.is_char_boundary(end) {
        end -= 1;
    }
    let end = answer[..end].rfind('\n').unwrap_or(end);
    format!(
        "{}\n… cut: {} more characters (a narrower query or focus shows the rest)",
        &answer[..end],
        answer.len() - end
    )
}

fn is_secret(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    [
        "pass",
        "secret",
        "token",
        "key",
        "auth",
        "cookie",
        "session",
        "credential",
        "signature",
    ]
    .iter()
    .any(|part| name.contains(part))
}

// ---------- lists ----------

/// A trace in a list: `GET /api/orders → 200`, `task send_digest (FAILURE)`.
fn listed_head(row: &Value) -> String {
    match text(row, "kind") {
        "http" if !text(row, "method").is_empty() => {
            let path = [text(row, "path"), text(row, "name")]
                .into_iter()
                .find(|part| !part.is_empty())
                .unwrap_or("");
            let mut head = format!("{} {path}", text(row, "method"));
            if let Some(status) = row.get("http_status").and_then(Value::as_i64) {
                head.push_str(&format!(" → {status}"));
            }
            head
        }
        kind => {
            let mut head = format!("{kind} {}", text(row, "name"));
            if let Some(state) = row.get("task_state").and_then(Value::as_str) {
                head.push_str(&format!(" ({state})"));
            } else if text(row, "status") == "error" {
                head.push_str(" (error)");
            }
            head
        }
    }
}

/// One line per trace: id, what it was, how long, its SQL and issues, when.
pub(crate) fn trace_line(row: &Value, now: i64) -> String {
    let mut parts = vec![listed_head(row), ms(int(row, "duration"))];
    let queries = int(row, "queries");
    if queries > 0 {
        parts.push(format!("{queries} SQL ({})", ms(int(row, "db_time"))));
    }
    let kinds: Vec<&str> = row
        .get("issue_kinds")
        .and_then(Value::as_array)
        .map(|kinds| kinds.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    if !kinds.is_empty() {
        parts.push(format!("issues: {}", kinds.join(", ")));
    }
    parts.push(ago(int(row, "start"), now));
    format!("{}  {}", text(row, "id"), parts.join(" · "))
}

pub(crate) fn issue_lines(row: &Value, now: i64) -> String {
    let mut lines = format!("{}  {}", text(row, "kind"), text(row, "title"));
    if !text(row, "culprit").is_empty() {
        lines.push_str(&format!("\n    at {}", text(row, "culprit")));
    }
    if !text(row, "hint").is_empty() {
        lines.push_str(&format!("\n    fix: {}", text(row, "hint")));
    }
    let mut facts = vec![
        format!("{}×", int(row, "occurrences")),
        format!("last {}", ago(int(row, "last_seen"), now)),
    ];
    let endpoints: Vec<&str> = row
        .get("endpoints")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    if !endpoints.is_empty() {
        facts.push(format!("on {}", endpoints.join(", ")));
    }
    facts.push(format!("fingerprint {}", text(row, "fingerprint")));
    lines.push_str(&format!("\n    {}", facts.join(" · ")));
    lines
}

pub(crate) fn endpoint_line(row: &Value, now: i64) -> String {
    let mut parts = vec![
        format!("{} {}", text(row, "method"), text(row, "route")),
        count(int(row, "calls"), "call", "calls"),
        format!("p50 {}", ms(int(row, "p50"))),
        format!("p95 {}", ms(int(row, "p95"))),
    ];
    let avg = row
        .get("avg_queries")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    if avg > 0.0 {
        parts.push(format!("{avg:.1} SQL avg"));
    }
    for (key, what) in [("errors", "errors"), ("with_issues", "with issues")] {
        if int(row, key) > 0 {
            parts.push(format!("{} {what}", int(row, key)));
        }
    }
    parts.push(format!("last {}", ago(int(row, "last_seen"), now)));
    parts.join(" · ")
}

/// A group of calls: its system and target, how often and how long, then the statement (or operation) and where
/// to look, a sample trace and the key `call:` finds its traces by.
pub(crate) fn call_lines(row: &Value) -> String {
    let what = ["statement", "template", "name"]
        .into_iter()
        .map(|key| text(row, key))
        .find(|value| !value.is_empty())
        .unwrap_or("");
    let mut parts = vec![
        [text(row, "system"), text(row, "target")]
            .into_iter()
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>()
            .join(" "),
        format!(
            "×{} in {}",
            int(row, "calls"),
            count(int(row, "traces"), "trace", "traces")
        ),
        format!("up to {} per trace", int(row, "most_per_trace")),
        format!("total {}", ms(int(row, "total"))),
        format!("slowest {}", ms(int(row, "slowest"))),
    ];
    if !text(row, "origin").is_empty() {
        parts.push(text(row, "origin").to_owned());
    }
    format!(
        "{}\n    {}\n    e.g. trace {} · call:{}",
        parts.join(" · "),
        short(what, STATEMENT),
        text(row, "sample_trace"),
        text(row, "key")
    )
}

pub(crate) fn log_line(row: &Value, now: i64) -> String {
    format!(
        "{} {} {}: {} · {} ({})",
        ago(int(row, "time"), now),
        text(row, "level"),
        text(row, "logger"),
        short(text(row, "message"), MESSAGE),
        text(row, "trace_name"),
        text(row, "trace_id")
    )
}

// ---------- one trace ----------

fn spans(doc: &Value) -> &[Value] {
    doc.get("spans")
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

fn sql_spans(doc: &Value) -> impl Iterator<Item = &Value> {
    spans(doc).iter().filter(|span| text(span, "kind") == "sql")
}

/// The statement a SQL span runs, without its values.
fn statement(span: &Value) -> &str {
    let attrs = &span["attrs"];
    [
        text(attrs, "db.fingerprint"),
        text(attrs, "db.statement"),
        text(span, "name"),
    ]
    .into_iter()
    .find(|part| !part.is_empty())
    .unwrap_or("")
}

/// `GET /api/orders → 200 · 31 ms · 101 SQL (2.0 ms) · view shop.api.orders`
pub(crate) fn trace_head(doc: &Value) -> String {
    let attrs = &doc["attrs"];
    let mut head = match text(doc, "kind") {
        "http" if !text(attrs, "http.method").is_empty() => {
            let path = [text(attrs, "http.path"), text(doc, "name")]
                .into_iter()
                .find(|part| !part.is_empty())
                .unwrap_or("");
            let mut head = format!("{} {path}", text(attrs, "http.method"));
            if let Some(status) = attrs.get("http.status_code").and_then(Value::as_i64) {
                head.push_str(&format!(" → {status}"));
            }
            head
        }
        kind => {
            let mut head = format!("{kind} {}", text(doc, "name"));
            if text(doc, "status") == "error" {
                head.push_str(" (error)");
            }
            head
        }
    };
    head.push_str(&format!(" · {}", ms(int(doc, "duration"))));
    let (count, time) = sql_spans(doc).fold((0, 0), |(count, time), span| {
        (count + 1, time + int(span, "duration"))
    });
    if count > 0 {
        head.push_str(&format!(" · {count} SQL ({})", ms(time)));
    }
    if !text(attrs, "code.view").is_empty() {
        head.push_str(&format!(" · view {}", text(attrs, "code.view")));
    }
    head
}

fn issues_section(doc: &Value) -> String {
    let issues = doc
        .get("issues")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice);
    if issues.is_empty() {
        return "issues: none".into();
    }
    let mut out = format!("issues ({}):", issues.len());
    for issue in issues {
        out.push_str(&format!(
            "\n  {}  {}",
            text(issue, "kind"),
            text(issue, "title")
        ));
        if !text(issue, "culprit").is_empty() {
            out.push_str(&format!("\n      at {}", text(issue, "culprit")));
        }
        if !text(issue, "hint").is_empty() {
            out.push_str(&format!("\n      fix: {}", text(issue, "hint")));
        }
        out.push_str(&format!(
            "\n      fingerprint {}",
            text(issue, "fingerprint")
        ));
    }
    out
}

fn frame_lines(frame: &Value, values: bool) -> String {
    let mut out = format!(
        "    {}:{} in {}",
        text(frame, "filename"),
        int(frame, "lineno"),
        text(frame, "function")
    );
    let line = frame
        .get("context")
        .and_then(Value::as_array)
        .and_then(|context| {
            let at = usize::try_from(int(frame, "lineno") - int(frame, "context_start")).ok()?;
            context.get(at)?.as_str()
        });
    if let Some(line) = line.filter(|line| !line.trim().is_empty()) {
        out.push_str(&format!("\n      > {}", line.trim()));
    }
    if values && let Some(locals) = frame.get("locals").and_then(Value::as_object) {
        let shown: Vec<String> = locals
            .iter()
            .map(|(name, value)| {
                let value = if is_secret(name) {
                    "***".to_owned()
                } else {
                    short(value.as_str().unwrap_or(&value.to_string()), 80)
                };
                format!("{name}={value}")
            })
            .collect();
        if !shown.is_empty() {
            out.push_str(&format!("\n      locals: {}", shown.join(", ")));
        }
    }
    out
}

/// The project's frames (the last ones, where it broke), or the last frames when none is the project's.
fn frames_section(frames: &[Value], values: bool) -> String {
    let own: Vec<&Value> = frames
        .iter()
        .filter(|frame| frame.get("in_app").and_then(Value::as_bool) == Some(true))
        .collect();
    let shown: Vec<&Value> = if own.is_empty() {
        frames.iter().collect()
    } else {
        own
    };
    let skip = shown.len().saturating_sub(6);
    let mut out = String::new();
    if skip > 0 {
        out.push_str(&format!("\n    … {skip} earlier frames"));
    }
    for frame in &shown[skip..] {
        out.push('\n');
        out.push_str(&frame_lines(frame, values));
    }
    out
}

fn errors_section(doc: &Value, values: bool) -> Option<String> {
    let errors = doc.get("errors").and_then(Value::as_array)?;
    if errors.is_empty() {
        return None;
    }
    let mut out = String::new();
    for error in errors {
        let handled = if error.get("handled").and_then(Value::as_bool) == Some(true) {
            "handled"
        } else {
            "unhandled"
        };
        out.push_str(&format!(
            "\nerror ({handled}): {}: {}",
            text(error, "type"),
            short(text(error, "message"), MESSAGE)
        ));
        let frames = error
            .get("frames")
            .and_then(Value::as_array)
            .map_or(&[][..], Vec::as_slice);
        out.push_str(&frames_section(frames, values));
        for inner in error
            .get("chain")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let relation = if text(inner, "relation") == "cause" {
                "caused by"
            } else {
                "while handling"
            };
            out.push_str(&format!(
                "\n  {relation} {}: {}",
                text(inner, "type"),
                short(text(inner, "message"), MESSAGE)
            ));
            let frames = inner
                .get("frames")
                .and_then(Value::as_array)
                .map_or(&[][..], Vec::as_slice);
            out.push_str(&frames_section(frames, values));
        }
    }
    Some(out.trim_start().to_owned())
}

const LOUD: [&str; 3] = ["warning", "error", "critical"];

fn logs_section(doc: &Value, all: bool) -> Option<String> {
    let logs: Vec<&Value> = doc
        .get("logs")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|log| all || LOUD.contains(&text(log, "level")))
        .collect();
    if logs.is_empty() {
        return None;
    }
    let mut out = if all {
        format!("logs ({}):", logs.len())
    } else {
        format!("logs from warning ({}):", logs.len())
    };
    for log in logs.iter().take(if all { 200 } else { 10 }) {
        let attrs = &log["attrs"];
        out.push_str(&format!(
            "\n  {} {}: {}",
            text(log, "level"),
            text(log, "logger"),
            short(text(log, "message"), MESSAGE)
        ));
        if !text(attrs, "code.filepath").is_empty() {
            out.push_str(&format!(
                " ({}:{})",
                text(attrs, "code.filepath"),
                int(attrs, "code.lineno")
            ));
        }
    }
    Some(out)
}

/// Every statement once: how often, how long, from where; the slowest in total first.
fn sql_section(doc: &Value, values: bool) -> String {
    let mut order: Vec<&str> = Vec::new();
    let mut groups: HashMap<&str, Vec<&Value>> = HashMap::new();
    for span in sql_spans(doc) {
        let key = statement(span);
        if !groups.contains_key(key) {
            order.push(key);
        }
        groups.entry(key).or_default().push(span);
    }
    if order.is_empty() {
        return "SQL: none".into();
    }
    let total = |key: &str| -> i64 { groups[key].iter().map(|span| int(span, "duration")).sum() };
    order.sort_by_key(|key| std::cmp::Reverse(total(key)));
    let count: usize = groups.values().map(Vec::len).sum();
    let mut out = format!(
        "SQL: {count} queries, {} statements, {}",
        order.len(),
        ms(order.iter().map(|key| total(key)).sum())
    );
    for key in order {
        let spans = &groups[key];
        let origin = text(&spans[0]["attrs"], "code.origin");
        out.push_str(&format!("\n  ×{} · {}", spans.len(), ms(total(key))));
        if !origin.is_empty() {
            out.push_str(&format!(" · {origin}"));
        }
        out.push_str(&format!("\n    {}", short(key, STATEMENT)));
        if values && let Some(params) = spans[0]["attrs"].get("db.params").filter(|p| !p.is_null())
        {
            out.push_str(&format!(
                "\n    params: {}",
                short(&params.to_string(), 200)
            ));
        }
    }
    out
}

/// The call tree: siblings with the same work folded into one line (`sql SELECT auth_user ×50`), with the issues
/// they are part of. `Focus::Issues` keeps what has an issue or an error under it, and branches of a tenth of the
/// time or more; the rest is a count.
fn tree_section(doc: &Value, focus: Focus) -> String {
    let spans = spans(doc);
    let total = int(doc, "duration").max(1);
    let ids: HashMap<&str, usize> = spans
        .iter()
        .enumerate()
        .map(|(index, span)| (text(span, "id"), index))
        .collect();
    let mut children: Vec<Vec<usize>> = vec![Vec::new(); spans.len()];
    let mut roots = Vec::new();
    for (index, span) in spans.iter().enumerate() {
        match span
            .get("parent_id")
            .and_then(Value::as_str)
            .and_then(|parent| ids.get(parent))
        {
            Some(&parent) if parent != index => children[parent].push(index),
            _ => roots.push(index),
        }
    }
    for list in &mut children {
        list.sort_by_key(|&index| int(&spans[index], "start"));
    }

    // Which issues each span is part of, and which spans failed.
    let mut marks: HashMap<&str, Vec<&str>> = HashMap::new();
    for issue in doc
        .get("issues")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        for id in issue
            .get("span_ids")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(id) = id.as_str() {
                marks.entry(id).or_default().push(text(issue, "kind"));
            }
        }
    }
    let failed: HashSet<&str> = spans
        .iter()
        .filter(|span| text(span, "status") == "error")
        .map(|span| text(span, "id"))
        .chain(
            doc.get("errors")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|error| text(error, "span_id")),
        )
        .collect();

    // What a branch holds that matters: an issue or an error anywhere under it.
    let mut notable = vec![false; spans.len()];
    fn mark(
        index: usize,
        spans: &[Value],
        children: &[Vec<usize>],
        flagged: &dyn Fn(&Value) -> bool,
        notable: &mut [bool],
    ) -> bool {
        let mut found = flagged(&spans[index]);
        for &child in &children[index] {
            found |= mark(child, spans, children, flagged, notable);
        }
        notable[index] = found;
        found
    }
    let flagged = |span: &Value| {
        let id = text(span, "id");
        marks.contains_key(id) || failed.contains(id)
    };
    for &root in &roots {
        mark(root, spans, &children, &flagged, &mut notable);
    }

    struct Walk<'a> {
        spans: &'a [Value],
        children: &'a [Vec<usize>],
        marks: &'a HashMap<&'a str, Vec<&'a str>>,
        failed: &'a HashSet<&'a str>,
        notable: &'a [bool],
        keep_all: bool,
        total: i64,
        lines: Vec<String>,
        hidden: (usize, i64),
    }

    impl Walk<'_> {
        fn subtree(&self, index: usize) -> usize {
            1 + self.children[index]
                .iter()
                .map(|&child| self.subtree(child))
                .sum::<usize>()
        }

        fn hide(&mut self, group: &[usize]) {
            for &index in group {
                self.hidden.0 += self.subtree(index);
                self.hidden.1 += int(&self.spans[index], "duration");
            }
        }

        /// Siblings grouped by what they do, in the order they first ran.
        fn level(&mut self, siblings: &[usize], depth: usize) {
            let mut order: Vec<String> = Vec::new();
            let mut groups: HashMap<String, Vec<usize>> = HashMap::new();
            for &index in siblings {
                let span = &self.spans[index];
                let key = format!(
                    "{}\u{0}{}\u{0}{}",
                    text(span, "kind"),
                    text(span, "name"),
                    statement(span)
                );
                if !groups.contains_key(&key) {
                    order.push(key.clone());
                }
                groups.entry(key).or_default().push(index);
            }
            for key in order {
                let group = groups.remove(&key).unwrap_or_default();
                let time: i64 = group
                    .iter()
                    .map(|&index| int(&self.spans[index], "duration"))
                    .sum();
                let keep = self.keep_all
                    || group.iter().any(|&index| self.notable[index])
                    || time * 10 >= self.total;
                if !keep || self.lines.len() >= TREE_LINES {
                    self.hide(&group);
                    continue;
                }
                self.line(&group, time, depth);
                if group.len() == 1 {
                    let below = self.children[group[0]].clone();
                    self.level(&below, depth + 1);
                } else {
                    // A repeated call: its own children once each would say the same thing again.
                    for &index in &group {
                        let below = self.children[index].clone();
                        self.hide(&below);
                    }
                }
            }
        }

        fn line(&mut self, group: &[usize], time: i64, depth: usize) {
            let span = &self.spans[group[0]];
            let mut line = format!(
                "{}{} {}",
                "  ".repeat(depth + 1),
                text(span, "kind"),
                short(text(span, "name"), 120)
            );
            if group.len() > 1 {
                line.push_str(&format!(" ×{}", group.len()));
            }
            line.push_str(&format!(" · {}", ms(time)));
            let mut kinds: Vec<&str> = group
                .iter()
                .filter_map(|&index| self.marks.get(text(&self.spans[index], "id")))
                .flatten()
                .copied()
                .collect();
            if group
                .iter()
                .any(|&index| self.failed.contains(text(&self.spans[index], "id")))
            {
                kinds.push("error");
            }
            kinds.sort_unstable();
            kinds.dedup();
            if !kinds.is_empty() {
                line.push_str(&format!("  [{}]", kinds.join(", ")));
            }
            let origin = text(&span["attrs"], "code.origin");
            if !origin.is_empty() && (text(span, "kind") == "sql" || !kinds.is_empty()) {
                line.push_str(&format!(" — {origin}"));
            }
            self.lines.push(line);
        }
    }

    let mut walk = Walk {
        spans,
        children: &children,
        marks: &marks,
        failed: &failed,
        notable: &notable,
        keep_all: focus == Focus::Tree,
        total,
        lines: Vec::new(),
        hidden: (0, 0),
    };
    walk.level(&roots, 0);
    let title = if focus == Focus::Tree {
        "tree:"
    } else {
        "tree (issues, errors and the slow branches):"
    };
    let mut out = format!("{title}\n{}", walk.lines.join("\n"));
    if walk.hidden.0 > 0 {
        let more = if focus == Focus::Tree {
            ""
        } else {
            "; focus=tree shows them"
        };
        out.push_str(&format!(
            "\n  … {} · {}{more}",
            count(walk.hidden.0 as i64, "more span", "more spans"),
            ms(walk.hidden.1)
        ));
    }
    out
}

fn related_section(related: &Value, now: i64) -> Option<String> {
    let mut out = Vec::new();
    for (key, what) in [
        ("enqueued_by", "enqueued by"),
        ("connection", "in connection"),
        ("sent_by", "sent by"),
    ] {
        if related.get(key).is_some_and(Value::is_object) {
            out.push(format!("{what}: {}", trace_line(&related[key], now)));
        }
    }
    for (key, what) in [
        ("enqueued", "enqueued"),
        ("connection_events", "connection events"),
        ("delivered", "delivered"),
    ] {
        let items = related
            .get(key)
            .and_then(Value::as_array)
            .map_or(&[][..], Vec::as_slice);
        if !items.is_empty() {
            out.push(format!("{what} ({}):", items.len()));
            out.extend(
                items
                    .iter()
                    .take(20)
                    .map(|item| format!("  {}", trace_line(item, now))),
            );
        }
    }
    out.extend(workflow_lines(&related["workflow"], now));
    (!out.is_empty()).then(|| out.join("\n"))
}

/// A task run's workflow: its root, the runs before and after it, its group's other tasks.
fn workflow_lines(workflow: &Value, now: i64) -> Vec<String> {
    let mut out = Vec::new();
    if workflow["root"].is_object() {
        out.push(format!(
            "workflow root: {}",
            trace_line(&workflow["root"], now)
        ));
    }
    let group = &workflow["group"];
    let label = format!(
        "group {} ({})",
        text(group, "id"),
        count(int(group, "tasks"), "task", "tasks")
    );
    for (items, what) in [
        (&workflow["follows"], "follows".to_owned()),
        (&workflow["followed_by"], "followed by".to_owned()),
        (&group["runs"], label),
    ] {
        let items = items.as_array().map_or(&[][..], Vec::as_slice);
        if !items.is_empty() {
            out.push(format!("{what}:"));
            out.extend(
                items
                    .iter()
                    .take(20)
                    .map(|item| format!("  {}", trace_line(item, now))),
            );
        }
    }
    out
}

/// One trace, compact: the head, its issues, then what `focus` asks for, errors, loud logs and related traces.
pub(crate) fn trace(doc: &Value, related: &Value, focus: Focus, values: bool, now: i64) -> String {
    let mut head = format!("{}  {}", text(doc, "id"), trace_head(doc));
    let profiled = profile::kinds(doc);
    if !profiled.is_empty() {
        head.push_str(&format!(
            "\nprofiled: {} → get_profile",
            profiled.join(", ")
        ));
    }
    let mut parts = vec![head, issues_section(doc)];
    if let Some(errors) = errors_section(doc, values) {
        parts.push(errors);
    }
    match focus {
        Focus::Issues | Focus::Tree => {
            parts.push(tree_section(doc, focus));
            parts.extend(logs_section(doc, false));
        }
        Focus::Sql => parts.push(sql_section(doc, values)),
        Focus::Logs => parts.push(logs_section(doc, true).unwrap_or_else(|| "logs: none".into())),
    }
    parts.extend(related_section(related, now));
    parts.join("\n\n")
}

/// What changed between two runs of the same thing: time, SQL, statements and issues.
pub(crate) fn compare(before: &Value, after: &Value) -> String {
    let sql = |doc: &Value| -> (i64, i64) {
        sql_spans(doc).fold((0, 0), |(count, time), span| {
            (count + 1, time + int(span, "duration"))
        })
    };
    let change = |old: i64, new: i64| -> String {
        if old == 0 {
            return String::new();
        }
        format!(" ({:+.0}%)", (new - old) as f64 * 100.0 / old as f64)
    };
    let (before_sql, before_db) = sql(before);
    let (after_sql, after_db) = sql(after);
    let mut out = vec![
        format!("before  {}  {}", text(before, "id"), trace_head(before)),
        format!("after   {}  {}", text(after, "id"), trace_head(after)),
        String::new(),
        format!(
            "time: {} → {}{}",
            ms(int(before, "duration")),
            ms(int(after, "duration")),
            change(int(before, "duration"), int(after, "duration"))
        ),
        format!(
            "SQL: {before_sql} → {after_sql} queries{}, {} → {}",
            change(before_sql, after_sql),
            ms(before_db),
            ms(after_db)
        ),
    ];
    if text(before, "status") != text(after, "status") {
        out.push(format!(
            "status: {} → {}",
            text(before, "status"),
            text(after, "status")
        ));
    }

    let issues = |doc: &Value| -> Vec<(String, String)> {
        doc.get("issues")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|issue| {
                let mut line = format!("{}  {}", text(issue, "kind"), text(issue, "title"));
                if !text(issue, "culprit").is_empty() {
                    line.push_str(&format!(" — {}", text(issue, "culprit")));
                }
                (text(issue, "fingerprint").to_owned(), line)
            })
            .collect()
    };
    let (old, new) = (issues(before), issues(after));
    let has =
        |list: &[(String, String)], fingerprint: &str| list.iter().any(|(f, _)| f == fingerprint);
    let gone: Vec<&String> = old
        .iter()
        .filter(|(f, _)| !has(&new, f))
        .map(|(_, line)| line)
        .collect();
    let added: Vec<&String> = new
        .iter()
        .filter(|(f, _)| !has(&old, f))
        .map(|(_, line)| line)
        .collect();
    let kept = new.len() - added.len();
    out.push(format!(
        "issues: {} → {} ({} fixed, {} new, {kept} still there)",
        old.len(),
        new.len(),
        gone.len(),
        added.len()
    ));
    out.extend(gone.iter().map(|line| format!("  fixed  {line}")));
    out.extend(added.iter().map(|line| format!("  new    {line}")));

    let counts = |doc: &Value| -> Vec<(String, i64)> {
        let mut counts: Vec<(String, i64)> = Vec::new();
        for span in sql_spans(doc) {
            let key = statement(span);
            match counts.iter_mut().find(|(k, _)| k == key) {
                Some((_, count)) => *count += 1,
                None => counts.push((key.to_owned(), 1)),
            }
        }
        counts
    };
    let (old, new) = (counts(before), counts(after));
    let mut changes = Vec::new();
    for (key, count) in &old {
        let now = new.iter().find(|(k, _)| k == key).map_or(0, |(_, c)| *c);
        if now != *count {
            changes.push((
                count - now,
                format!("  ×{count} → ×{now}  {}", short(key, 200)),
            ));
        }
    }
    for (key, count) in &new {
        if !old.iter().any(|(k, _)| k == key) {
            changes.push((-count, format!("  ×0 → ×{count}  {}", short(key, 200))));
        }
    }
    if !changes.is_empty() {
        changes.sort_by_key(|(delta, _)| std::cmp::Reverse(delta.abs()));
        out.push(format!("statements that changed ({}):", changes.len()));
        out.extend(changes.into_iter().take(15).map(|(_, line)| line));
    }
    out.extend(profile::compare(before, after));
    out.join("\n")
}

#[cfg(test)]
mod tests {
    use super::ms;

    #[test]
    fn times_read_as_the_console_says_them() {
        assert_eq!(
            [
                400, 27_600, 376_000, 999_000, 1_000_000, 7_910_000, 12_345_000
            ]
            .map(ms),
            [
                "0.4 ms", "27.6 ms", "376 ms", "999 ms", "1.0 s", "7.9 s", "12.3 s"
            ]
        );
    }
}
