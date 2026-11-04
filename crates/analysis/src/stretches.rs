//! Where a trace's time went, moment by moment: the deepest span running then and the category its time counts in
//! (the console's `stretches`, `ui/packages/ui/src/lib/breakdown.ts`). What the MCP server's shares split a trace's
//! time by, and what a CPU profile's samples are spread over at ingest (profiles).

use serde_json::Value;
use std::collections::{HashMap, HashSet};

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

fn int(value: &Value, key: &str) -> i64 {
    value.get(key).and_then(Value::as_i64).unwrap_or(0)
}

/// The categories whose time is the code's own: a profile splits it into its waits and what ran.
pub const OWN_CODE: [&str; 4] = ["code", "django", "signal", "template"];

/// A span kind's category, where it has one of its own (the console's `BY_KIND`).
pub fn by_kind(kind: &str) -> Option<&'static str> {
    Some(match kind {
        "sql" | "sql.connect" => "sql",
        "redis" => "redis",
        "cache" => "cache",
        "http.client" | "grpc" | "rpc" => "http",
        "mongodb" | "elasticsearch" | "cassandra" | "dynamodb" | "memcached" | "db" => "datastore",
        "kafka" | "rabbitmq" | "sqs" | "messaging" => "messaging",
        "storage" => "storage",
        "llm" => "llm",
        "mail" => "mail",
        "template" => "template",
        "signal" => "signal",
        "view"
        | "function"
        | "task"
        | "task.run"
        | "command"
        | "migration"
        | "migration.operation" => "code",
        _ => return None,
    })
}

/// A span as its time is told: its id, its parent's, its kind, when it ran (µs), and its document.
pub struct Span<'a> {
    pub id: &'a str,
    pub parent: Option<&'a str>,
    pub kind: &'a str,
    pub start: i64,
    pub end: i64,
    pub raw: &'a Value,
}

/// The trace's spans, by id.
pub fn spans_of(doc: &Value) -> Vec<Span<'_>> {
    doc.get("spans")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|span| Span {
            id: text(span, "id"),
            parent: span.get("parent_id").and_then(Value::as_str),
            kind: text(span, "kind"),
            start: int(span, "start"),
            end: int(span, "start") + int(span, "duration"),
            raw: span,
        })
        .collect()
}

/// The spans' categories, as the console counts each span's time (`spanCategories`): its own, or its owner's.
struct Owners<'a> {
    by_id: HashMap<&'a str, &'a Span<'a>>,
    handled: bool,
}

impl<'a> Owners<'a> {
    fn new(spans: &'a [Span<'a>]) -> Self {
        Self {
            by_id: spans.iter().map(|span| (span.id, span)).collect(),
            handled: spans.iter().any(|span| span.kind == "view"),
        }
    }

    fn parent(&self, span: &Span<'a>) -> Option<&'a Span<'a>> {
        span.parent.and_then(|id| self.by_id.get(id).copied())
    }

    /// A cache's Redis commands are the cache's time, an LLM call's HTTP requests the model's, a query's the
    /// database's: what the app asked for, on whatever serves it.
    fn served_for(&self, span: &'a Span<'a>) -> &'a Span<'a> {
        let owners: &[&str] = match span.kind {
            "redis" => &["cache"],
            "http.client" => &["llm", "sql", "sql.connect"],
            _ => return span,
        };
        match self.parent(span) {
            Some(parent) if owners.contains(&parent.kind) => parent,
            _ => span,
        }
    }

    fn own_category(&self, span: &Span<'a>) -> Option<&'static str> {
        if span.kind == "transaction" {
            return None;
        }
        if span.kind == "function"
            && self
                .parent(span)
                .is_some_and(|parent| parent.kind == "signal")
        {
            return Some("signal");
        }
        by_kind(span.kind).or(match span.parent {
            None if self.handled => Some("django"),
            None => Some("code"),
            Some(_) if matches!(span.kind, "middleware" | "framework") => Some("django"),
            Some(_) => None,
        })
    }

    fn category(&self, span: &'a Span<'a>) -> Option<&'static str> {
        let mut current = Some(self.served_for(span));
        while let Some(at) = current {
            if let Some(category) = self.own_category(at) {
                return Some(category);
            }
            current = self.parent(at);
        }
        None
    }

    fn depth(&self, span: &Span<'a>, depths: &mut HashMap<&'a str, usize>) -> usize {
        let mut chain = Vec::new();
        let mut at = self.by_id.get(span.id).copied();
        let mut base = 0;
        while let Some(current) = at {
            if let Some(&known) = depths.get(current.id) {
                base = known + 1;
                break;
            }
            chain.push(current.id);
            at = self.parent(current);
        }
        for (index, id) in chain.iter().rev().enumerate() {
            depths.insert(id, base + index);
        }
        depths.get(span.id).copied().unwrap_or(0)
    }
}

/// A stretch of the trace's time (µs since it started): the deepest span running then, its category, and whether
/// that was its own code with calls of its own around (`quiet`).
pub struct Stretch<'a> {
    pub from: f64,
    pub to: f64,
    pub category: &'static str,
    pub quiet: bool,
    pub span: &'a str,
}

/// Where the trace's time went, moment by moment, for the deepest span running then (the console's `stretches`).
pub fn stretches<'a>(doc: &Value, spans: &'a [Span<'a>]) -> Vec<Stretch<'a>> {
    let start = int(doc, "start");
    let owners = Owners::new(spans);
    let callers: HashSet<&str> = spans.iter().filter_map(|span| span.parent).collect();
    let timed: Vec<&Span> = spans.iter().filter(|span| span.end > span.start).collect();
    let mut edges: Vec<i64> = timed
        .iter()
        .flat_map(|span| [span.start, span.end])
        .collect();
    edges.sort_unstable();
    edges.dedup();
    let mut depths = HashMap::new();
    let mut list: Vec<Stretch> = Vec::new();
    for pair in edges.windows(2) {
        let (from, to) = (pair[0], pair[1]);
        let mut innermost: Option<(&Span, usize)> = None;
        for &span in &timed {
            if !(span.start <= from && span.end >= to) {
                continue;
            }
            let depth = owners.depth(span, &mut depths);
            let deeper = innermost.is_none_or(|(best, best_depth)| {
                depth > best_depth || (depth == best_depth && span.start > best.start)
            });
            if deeper {
                innermost = Some((span, depth));
            }
        }
        let Some((span, _)) = innermost else { continue };
        let Some(category) = owners.category(span) else {
            continue;
        };
        let next = Stretch {
            from: (from - start) as f64,
            to: (to - start) as f64,
            category,
            quiet: callers.contains(span.id),
            span: span.id,
        };
        match list.last_mut() {
            Some(last)
                if last.to == next.from && last.span == next.span && last.quiet == next.quiet =>
            {
                last.to = next.to;
            }
            _ => list.push(next),
        }
    }
    list
}
