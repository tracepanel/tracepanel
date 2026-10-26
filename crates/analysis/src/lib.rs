//! N+1 detection, duplicate and slow SQL, long transactions, htmx mistakes and error grouping: the issues of every
//! trace, whichever SDK recorded it, with stable fingerprints so a problem groups as one. The SDKs normalize SQL
//! (`db.fingerprint`) when they record it; spans an OpenTelemetry instrumentation recorded are mapped first (`otel`),
//! the same way. tracepanel-python's tests check the issues through the console's API.

use regex::Regex;
use serde_json::Value;
use serde_json::value::RawValue;
use sha1::{Digest, Sha1};
use std::collections::{BTreeMap, HashMap};
use std::sync::LazyLock;
use tracepanel_protocol::{Attrs, Issue, Span, Thresholds, Trace};

pub mod calls;
pub mod otel;
pub mod storage;
mod waits;

pub const FINGERPRINT_VERSION: i64 = 1;
const DUPLICATES_MIN: usize = 2;
const SPAN_IDS: usize = 50;
const TITLE_LIMIT: usize = 200;

static WHITESPACE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());
/// A placeholder, as each driver writes it: %s and %(name)s (Python), ? and ?1 (JDBC, ODBC, SQLite), $1
/// (PostgreSQL), @P1 and @name (SQL Server), :1 and :name (Oracle, SQLAlchemy). ASCII classes, not Unicode's `\w`:
/// a placeholder is always ASCII, and the regexes compile several times faster.
pub(crate) const PLACEHOLDER: &str =
    r"(?:%s|%\([A-Za-z0-9_]+\)s|\?[0-9]*|\$[0-9]+|@[A-Za-z0-9_]+|:[A-Za-z0-9_]+)";
/// A name, bare or quoted: "standard SQL", `MySQL`, [SQL Server].
pub(crate) const NAME: &str = r#"(?:[`"\[]?\w+[`"\]]?)"#;
// A lookup by primary key: `WHERE table.id = ?`, or `WHERE id = ?` (a hand-written query).
static BY_PK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r#"(?i)WHERE (?:{NAME}\.)?[`"\[]?id[`"\]]? = {PLACEHOLDER}"#
    ))
    .unwrap()
});
static LINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r":\d+ in ").unwrap());
// The parts of a URL path or a cache key that name one item: a number, a UUID, a long hex digest.
static UUID: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b").unwrap()
});
static HEX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b[0-9a-f]{16,}\b").unwrap());
static NUMBER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\b\d+\b").unwrap());

const SELECT_RELATED: &str = "Load the related object in the same query: add `select_related()` for this ForeignKey \
    to the queryset that produced these rows.";
const PREFETCH_RELATED: &str = "Load the related rows in one extra query: add `prefetch_related()` for this reverse \
    or many-to-many relation to the queryset that produced these rows.";
const JOINEDLOAD: &str = "Load the related object in the same query: add `joinedload()` for this relationship \
    to the select() that produced these rows (or `selectinload()` for one extra query).";
const SELECTINLOAD: &str = "Load the related rows in one extra query: add `selectinload()` for this relationship \
    to the select() that produced these rows.";
const N_PLUS_ONE: &str = "Load the related rows with the parent rows (a join, or one batched query) instead of one query per row.";
const DUPLICATES: &str = "Run the query once and reuse the result, or cache it for the request.";
const IN_GRAPHQL: &str =
    " In GraphQL, a resolver runs once per object: batch these lookups with a DataLoader";
const PREFETCH_IN_PARENT: &str = ", or prefetch in the parent resolver.";
const SLOW_SQL: &str = "Check the query plan (`EXPLAIN`) and add an index or narrow the query.";
const HTTP_REPEATED: &str =
    "Fetch them in one batch request, or call once and reuse the result for the request.";
const CACHE_REPEATED: &str = "Read or write the keys in one round trip (a multi-key command such as MGET, or a pipeline) instead of one per item.";
const HTTP_DUPLICATES: &str =
    "Make the call once and reuse the answer, or cache it for the request.";
const CACHE_DUPLICATES: &str = "Read the key once and keep the value for the request.";
const REDIS_REPEATED: &str = "Send the commands in one round trip (a multi-key command such as MGET, or a pipeline) \
    instead of one per item.";
const SLOW_HTTP: &str = "The request waits for the other service: set a timeout, cache the answer, or make the call \
    outside the request (in a background task).";
const LONG_TRANSACTION: &str = "Rows locked inside stay locked until COMMIT: keep slow work (HTTP calls, emails, \
    heavy Python) out of the `atomic()` block.";
const LONG_TRANSACTION_SQLALCHEMY: &str = "Rows locked inside stay locked until COMMIT: keep slow work (HTTP calls, \
    emails, heavy Python) out of the transaction: commit first, or do it before the `with session.begin()` / \
    transaction block.";
const REDIRECT_HINT: &str = "The browser follows a redirect inside htmx's request, and htmx swaps the page it lands \
    on into the target. Answer an htmx request with an `HX-Redirect` (or `HX-Location`) header to navigate the \
    browser, or with a 4xx the page shows.";
const FULL_PAGE_HINT: &str = "htmx swaps the response into its target element, so a whole page ends up nested in \
    this one. Render a fragment when the `HX-Request` header is set, or let the link load the page (`hx-boost`).";

const N_PLUS_ONE_IN_TEMPLATE: &str = "Load the related rows in the view, with the parent rows (a join, or one \
    batched query), and pass them to the template.";

/// What a GraphQL trace's N+1 hint adds: a DataLoader, the one of the server library the SDK names
/// (`graphql.library`), none named for a library it doesn't.
fn dataloader_hint(library: Option<&str>) -> String {
    let loader = match library {
        Some("strawberry") => " (`strawberry.dataloader`)",
        // graphene-django's GraphQLView runs resolvers in sync code, where aiodataloader's (Graphene's docs) can't
        // wait, and promise's DataLoader needs graphql-core 2.
        Some("graphene") => {
            " (graphql-sync-dataloaders' `SyncDataLoader` in graphene-django's sync view, aiodataloader in an async one)"
        }
        _ => "",
    };
    format!("{IN_GRAPHQL}{loader}{PREFETCH_IN_PARENT}")
}

fn n_plus_one_hint(client: &str, by_pk: bool, in_template: bool) -> &'static str {
    match (client, by_pk) {
        ("django", true) => SELECT_RELATED,
        ("django", false) => PREFETCH_RELATED,
        ("sqlalchemy", true) => JOINEDLOAD,
        ("sqlalchemy", false) => SELECTINLOAD,
        _ if in_template => N_PLUS_ONE_IN_TEMPLATE,
        _ => N_PLUS_ONE,
    }
}

/// The template that ran an N+1's queries as it rendered, if one did, with its line when the SDK knows it
/// (`code.template_line`): what the hint opens with.
fn template_lead(spans: &[&Span]) -> Option<String> {
    let (template, _) = most_common(
        spans
            .iter()
            .filter_map(|span| text(&span.attrs, "code.template")),
    )?;
    let line = most_common(spans.iter().filter_map(|span| {
        (text(&span.attrs, "code.template").as_deref() == Some(template.as_str()))
            .then(|| span.attrs.get("code.template_line").and_then(Value::as_i64))
            .flatten()
    }))
    .map(|(line, _)| format!(" (line {line})"))
    .unwrap_or_default();
    Some(format!(
        "The template `{template}` makes these queries as it renders{line}, one per row it shows. "
    ))
}

/// What happens too early before COMMIT: (title, Django's fix, SQLAlchemy's fix).
fn in_transaction(kind: &str) -> Option<(&'static str, &'static str, &'static str)> {
    match kind {
        "task.enqueue" => Some((
            "Task enqueued inside a transaction",
            "A worker can pick the task up before COMMIT and not see the data, or run it after a rollback: \
             enqueue it with `transaction.on_commit(lambda: task.delay(...))`.",
            "A worker can pick the task up before COMMIT and not see the data, or run it after a rollback: \
             enqueue it after the commit (after the transaction block, or in an `after_commit` session event).",
        )),
        "mail" => Some((
            "Email sent inside a transaction",
            "The email goes out even if the transaction rolls back: send it with `transaction.on_commit(...)`.",
            "The email goes out even if the transaction rolls back: send it after the commit.",
        )),
        "http.client" => Some((
            "HTTP call inside a transaction",
            "The transaction stays open, holding its locks, while the other service answers: make the call \
             before `atomic()` or in `transaction.on_commit(...)`.",
            "The transaction stays open, holding its locks, while the other service answers: make the call before \
             the transaction, or after the commit.",
        )),
        _ => None,
    }
}

// ---------- Python's view of values ----------

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64() != Some(0.0),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(items)) => !items.is_empty(),
        Some(Value::Object(map)) => !map.is_empty(),
    }
}

fn py_str(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => "None".into(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Bool(true)) => "True".into(),
        Some(Value::Bool(false)) => "False".into(),
        Some(Value::Number(number)) => match (number.as_i64(), number.as_f64()) {
            (Some(int), _) => int.to_string(),
            (None, Some(float)) if float.fract() == 0.0 && float.abs() < 1e16 => {
                format!("{float:.1}")
            }
            _ => number.to_string(),
        },
        Some(other) => other.to_string(),
    }
}

fn text(attrs: &Attrs, key: &str) -> Option<String> {
    attrs.get(key).and_then(Value::as_str).map(str::to_owned)
}

/// `str(attrs.get(key) or default)`.
fn or_default(attrs: &Attrs, key: &str, default: &str) -> String {
    let value = attrs.get(key);
    if truthy(value) {
        py_str(value)
    } else {
        default.into()
    }
}

/// Python's `f"{microseconds / 1000:.0f}"`: milliseconds, half to even.
fn milliseconds(micros: i64) -> i64 {
    let (whole, rest) = (micros.div_euclid(1000), micros.rem_euclid(1000));
    if rest > 500 || (rest == 500 && whole % 2 != 0) {
        whole + 1
    } else {
        whole
    }
}

/// Counter(...).most_common(1): the most frequent, the first seen on a tie.
fn most_common<T: Clone + Eq + std::hash::Hash>(
    items: impl IntoIterator<Item = T>,
) -> Option<(T, usize)> {
    let mut order: Vec<T> = Vec::new();
    let mut counts: HashMap<T, usize> = HashMap::new();
    for item in items {
        let count = counts.entry(item.clone()).or_insert(0);
        if *count == 0 {
            order.push(item);
        }
        *count += 1;
    }
    order.into_iter().fold(None, |best, item| {
        let count = counts[&item];
        match best {
            Some((_, top)) if top >= count => best,
            _ => Some((item, count)),
        }
    })
}

pub fn issue_key(kind: &str, parts: &[Option<&str>]) -> String {
    let mut raw = vec![FINGERPRINT_VERSION.to_string(), kind.to_owned()];
    raw.extend(parts.iter().map(|part| part.unwrap_or_default().to_owned()));
    let digest = Sha1::digest(raw.join("|").as_bytes());
    digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()[..16]
        .to_owned()
}

/// Where in project code: the template that issued the queries, if any, rendered from the view's line.
fn culprit(spans: &[&Span]) -> Option<String> {
    let origin = most_common(
        spans
            .iter()
            .filter_map(|span| text(&span.attrs, "code.origin")),
    )
    .map(|(o, _)| o);
    let template = most_common(
        spans
            .iter()
            .filter_map(|span| text(&span.attrs, "code.template")),
    )
    .map(|(t, _)| t);
    match (template, origin) {
        (Some(template), Some(origin)) => Some(format!("{template} (rendered from {origin})")),
        (Some(template), None) => Some(template),
        (None, origin) => origin,
    }
}

/// "blog/views.py:21 in post_list" -> "blog/views.py in post_list": line numbers shift with edits.
fn culprit_key(culprit: Option<&str>) -> Option<String> {
    culprit
        .filter(|c| !c.is_empty())
        .map(|c| LINE.replace_all(c, " in ").into_owned())
}

fn issue(
    fingerprint: String,
    kind: &str,
    title: String,
    culprit: Option<String>,
    hint: Option<&str>,
    count: usize,
    span_ids: Vec<String>,
) -> Issue {
    Issue {
        fingerprint,
        fingerprint_version: FINGERPRINT_VERSION,
        kind: kind.into(),
        title,
        culprit,
        hint: hint.map(str::to_owned),
        count: count as i64,
        span_ids: span_ids.into_iter().take(SPAN_IDS).collect(),
    }
}

// ---------- SQL ----------

fn sql_issues(trace: &Trace, thresholds: &Thresholds) -> Vec<Issue> {
    let mut issues = Vec::new();
    // The same statement on two databases is two different queries.
    let mut order: Vec<(String, String)> = Vec::new();
    let mut groups: HashMap<(String, String), Vec<&Span>> = HashMap::new();
    for span in trace.spans.iter().filter(|span| span.kind == "sql") {
        let key = (
            or_default(&span.attrs, "db.alias", "default"),
            py_str(span.attrs.get("db.fingerprint")),
        );
        if !groups.contains_key(&key) {
            order.push(key.clone());
        }
        groups.entry(key).or_default().push(span);
    }
    let dataloader = trace
        .attrs
        .contains_key("graphql.operation")
        .then(|| dataloader_hint(text(&trace.attrs, "graphql.library").as_deref()));
    let threshold = thresholds.n_plus_one.max(0) as usize;
    for (alias, statement) in order {
        let spans = &groups[&(alias.clone(), statement.clone())];
        let key = if alias == "default" {
            statement.clone()
        } else {
            format!("{alias}|{statement}")
        };
        let mut culprit_text = culprit(spans);
        // An SDK that can't see the parameters (Go's database/sql through OpenTelemetry) sends no hash: then only the
        // shape tells (a by-key lookup looped from one line), and repeats can't be called duplicates.
        let params_known = spans
            .iter()
            .all(|span| !matches!(span.attrs.get("db.params_hash"), None | Some(Value::Null)));
        let params: Vec<String> = spans
            .iter()
            .map(|span| py_str(span.attrs.get("db.params_hash")))
            .collect();
        let distinct = if params_known {
            params
                .iter()
                .collect::<std::collections::HashSet<_>>()
                .len()
        } else {
            0
        };
        let by_pk = BY_PK.is_match(&statement);
        let select = statement.to_uppercase().starts_with("SELECT");
        // Only actionable patterns: reads that project code triggers.
        let mut actionable = culprit_text.is_some() && select;
        // A loop of by-key lookups run entirely by a library is still the view's N+1.
        if culprit_text.is_none() && select && by_pk && distinct >= threshold {
            culprit_text =
                text(&trace.attrs, "code.view").map(|view| format!("{view} (in library code)"));
            actionable = culprit_text.is_some();
        }
        let origins: std::collections::HashSet<String> = spans
            .iter()
            .map(|span| py_str(span.attrs.get("code.origin")))
            .collect();
        let looped = spans.len() >= threshold && origins.len() == 1 && by_pk;
        let first = spans[0];
        let key_culprit = culprit_key(culprit_text.as_deref());
        if actionable && (distinct >= threshold || looped) {
            let lead = template_lead(spans);
            let hint = format!(
                "{}{}{}",
                lead.as_deref().unwrap_or_default(),
                n_plus_one_hint(&py_str(first.attrs.get("db.client")), by_pk, lead.is_some()),
                dataloader.as_deref().unwrap_or_default()
            );
            issues.push(issue(
                issue_key("n+1", &[Some(&key), key_culprit.as_deref()]),
                "n+1",
                format!("N+1: {} similar queries · {}", spans.len(), first.name),
                culprit_text.clone(),
                Some(&hint),
                spans.len(),
                spans.iter().map(|span| span.id.clone()).collect(),
            ));
        } else if actionable
            && params_known
            && most_common(params.iter()).is_some_and(|(_, count)| count >= DUPLICATES_MIN)
        {
            let counts =
                params
                    .iter()
                    .fold(HashMap::<&String, usize>::new(), |mut counts, hash| {
                        *counts.entry(hash).or_default() += 1;
                        counts
                    });
            let repeated: Vec<&&Span> = spans
                .iter()
                .zip(&params)
                .filter(|(_, hash)| counts[hash] >= DUPLICATES_MIN)
                .map(|(span, _)| span)
                .collect();
            issues.push(issue(
                issue_key("duplicates", &[Some(&key), key_culprit.as_deref()]),
                "duplicates",
                format!(
                    "Duplicate queries: {} identical · {}",
                    repeated.len(),
                    first.name
                ),
                culprit_text.clone(),
                Some(DUPLICATES),
                repeated.len(),
                repeated.iter().map(|span| span.id.clone()).collect(),
            ));
        }
        let slow: Vec<&Span> = spans
            .iter()
            .copied()
            .filter(|span| span.duration >= thresholds.slow_sql_ms * 1000)
            .collect();
        if !slow.is_empty() {
            let slowest = slow.iter().map(|span| span.duration).max().unwrap_or(0);
            issues.push(issue(
                issue_key("slow-sql", &[Some(&key), key_culprit.as_deref()]),
                "slow-sql",
                format!("Slow query: {} ms · {}", milliseconds(slowest), first.name),
                culprit(&slow),
                Some(&slow_sql_hint(&slow)),
                slow.len(),
                slow.iter().map(|span| span.id.clone()).collect(),
            ));
        }
    }
    issues
}

/// A statement that says how many rows it wants: LIMIT, FETCH FIRST (standard SQL, Oracle), TOP (SQL Server), ROWNUM.
static BOUNDED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b(?:LIMIT|FETCH\s+(?:FIRST|NEXT)|TOP|ROWNUM)\b").unwrap());

const LARGE_RESULT_HINT: &str = "The query has no LIMIT, and every row it returned was fetched (and, through an ORM, \
                                 made into an object). Paginate (LIMIT, Django's Paginator), fetch only what the page \
                                 shows, or for batch work stream it (.iterator()) and take only the columns used \
                                 (.values_list()).";

/// A SELECT with no LIMIT that returned `large_result_rows` rows or more (`db.response.returned_rows`, as the SDKs
/// count what was fetched): one issue per statement, by its largest result.
fn large_result_issues(trace: &Trace, thresholds: &Thresholds) -> Vec<Issue> {
    let rows = |span: &Span| {
        span.attrs
            .get("db.response.returned_rows")
            .and_then(Value::as_i64)
            .unwrap_or(0)
    };
    let mut order: Vec<String> = Vec::new();
    let mut groups: HashMap<String, Vec<&Span>> = HashMap::new();
    for span in trace.spans.iter().filter(|span| span.kind == "sql") {
        let statement = py_str(span.attrs.get("db.statement"));
        let select = statement.trim_start().to_uppercase().starts_with("SELECT");
        if !select || BOUNDED.is_match(&statement) || rows(span) < thresholds.large_result_rows {
            continue;
        }
        let key = py_str(span.attrs.get("db.fingerprint"));
        if !groups.contains_key(&key) {
            order.push(key.clone());
        }
        groups.entry(key).or_default().push(span);
    }
    order
        .into_iter()
        .map(|key| {
            let spans = &groups[&key];
            let largest = spans.iter().map(|span| rows(span)).max().unwrap_or(0);
            let culprit_text = culprit(spans);
            issue(
                issue_key(
                    "large-result",
                    &[Some(&key), culprit_key(culprit_text.as_deref()).as_deref()],
                ),
                "large-result",
                format!("Large result: {largest} rows · {}", spans[0].name),
                culprit_text,
                Some(LARGE_RESULT_HINT),
                spans.len(),
                spans.iter().map(|span| span.id.clone()).collect(),
            )
        })
        .collect()
}

/// A LIKE whose pattern starts with `%` (as Django's `contains` and `icontains` make): no index on the column helps.
static LIKE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\bI?LIKE\b").unwrap());
static LIKE_LEADING_WILDCARD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\bI?LIKE\s+(?:UPPER\(|LOWER\()?'%").unwrap());

const LIKE_HINT: &str = "Its LIKE pattern starts with %: no index on the column helps, so the database reads every \
                         row. Match the start instead (startswith), or index the column for searching: a trigram index \
                         (PostgreSQL's pg_trgm) or full-text search.";

fn leading_wildcard(span: &Span) -> bool {
    let statement = py_str(span.attrs.get("db.statement"));
    if !LIKE.is_match(&statement) {
        return false;
    }
    let pattern_param = span
        .attrs
        .get("db.params")
        .and_then(Value::as_array)
        .is_some_and(|params| {
            params
                .iter()
                .any(|param| param.as_str().is_some_and(|text| text.starts_with('%')))
        });
    pattern_param || LIKE_LEADING_WILDCARD.is_match(&statement)
}

/// What to do about a slow query, and why its index doesn't help when its LIKE pattern starts with `%`.
fn slow_sql_hint(slow: &[&Span]) -> String {
    if slow.iter().any(|span| leading_wildcard(span)) {
        format!("{SLOW_SQL} {LIKE_HINT}")
    } else {
        SLOW_SQL.to_owned()
    }
}

// ---------- HTTP calls, Redis and cache ----------

/// `user:42:profile` -> `user:{id}:profile`; `/users/42` -> `/users/{id}`: the item a call is about, as `{id}`.
/// The analysis groups calls by it, and the store aggregates them by it.
pub fn template(text: &str) -> String {
    let text = UUID.replace_all(text, "{id}");
    let text = HEX.replace_all(&text, "{id}");
    NUMBER.replace_all(&text, "{id}").into_owned()
}

/// One kind of outgoing call, as the issues see it: what makes two calls the same request or the same item.
struct Call<'a> {
    span: &'a Span,
    /// Calls to the same endpoint, or the same key pattern: `GET api.example.com/users/{id}`.
    group: String,
    /// How an issue's title names the group (the group itself, unless it has parts only for telling groups apart).
    title: String,
    /// The exact call: its full URL, or its key.
    exact: String,
    /// Whether making it twice is wasted: a read, not a write (two POSTs, or two INCRs, are two actions).
    read: bool,
}

// Operations that only read: Django's cache API, and Redis commands (lowercase).
const CACHE_READS: &[&str] = &[
    "get",
    "get_many",
    "has_key",
    "mget",
    "exists",
    "hget",
    "hmget",
    "hgetall",
    "hexists",
    "smembers",
    "sismember",
    "lrange",
    "lindex",
    "llen",
    "zrange",
    "zscore",
    "zcard",
    "scard",
    "strlen",
    "ttl",
    "type",
];

/// The endpoint an `http.client` span called: its method, host and path template (`/users/{id}`), whatever the query
/// string asks it. The analysis groups calls by it, and the store aggregates them by it.
pub fn http_endpoint(span: &Span) -> (String, String, String) {
    let method = or_default(&span.attrs, "http.request.method", "GET").to_uppercase();
    let url = text(&span.attrs, "url.full").unwrap_or_else(|| span.name.clone());
    // scheme://host:port/path?query -> host, path.
    let rest = url.split_once("://").map_or(url.as_str(), |(_, rest)| rest);
    let without_query = rest.split(['?', '#']).next().unwrap_or("");
    let (host, path) = without_query.split_once('/').unwrap_or((without_query, ""));
    let host = host.rsplit('@').next().unwrap_or(host);
    let host = text(&span.attrs, "server.address")
        .unwrap_or_else(|| host.split(':').next().unwrap_or(host).to_owned());
    (method, host, format!("/{}", template(path)))
}

fn http_call(span: &Span) -> Call<'_> {
    let (method, host, path) = http_endpoint(span);
    let url = text(&span.attrs, "url.full").unwrap_or_else(|| span.name.clone());
    let group = format!("{method} {host}{path}");
    Call {
        span,
        title: group.clone(),
        group,
        exact: format!("{method} {url}"),
        read: matches!(method.as_str(), "GET" | "HEAD" | "OPTIONS"),
    }
}

/// A string key names the item; the *_many ops and pipelines carry how many, which says nothing of which.
fn item_key<'a>(span: &'a Span, attr: &str) -> Option<&'a str> {
    match span.attrs.get(attr) {
        Some(Value::String(key)) => Some(key.as_str()),
        _ => None,
    }
}

/// A Django cache operation: its alias, its op (`get`) and its key template (`user:{id}`, "" for a count).
pub fn cache_op(span: &Span) -> (String, String, String) {
    let op = or_default(&span.attrs, "cache.op", &span.name).to_lowercase();
    let alias = or_default(&span.attrs, "cache.alias", "default");
    let key = item_key(span, "cache.key")
        .map(template)
        .unwrap_or_default();
    (alias, op, key)
}

/// A Redis command: its client's alias (`redis`, `redis/1`), the command (`GET`) and its key template.
pub fn redis_command(span: &Span) -> (String, String, String) {
    let command = text(&span.attrs, "db.operation")
        .unwrap_or_else(|| span.name.split_whitespace().next().unwrap_or("").to_owned())
        .to_uppercase();
    let alias = or_default(&span.attrs, "redis.alias", "redis");
    let key = item_key(span, "redis.key")
        .map(template)
        .unwrap_or_default();
    (alias, command, key)
}

/// Why a Redis command ran, by the nearest ancestor that asked a library for it: "cache" (a cache operation, such as
/// Django's cache over Redis), "task" (a task enqueued on a Redis broker), "direct" (the app's own call). The app
/// fixes an issue on the cache operation or the enqueue it made, not on the commands those sent.
pub fn redis_via(trace: &Trace, span: &Span) -> &'static str {
    let mut parent = span.parent_id.as_deref();
    // A bound in case of a cycle: no tree is that deep.
    for _ in 0..trace.spans.len() {
        let Some(id) = parent else { break };
        let Some(ancestor) = trace.spans.iter().find(|candidate| candidate.id == id) else {
            break;
        };
        match ancestor.kind.as_str() {
            "cache" => return "cache",
            "task.enqueue" => return "task",
            _ => parent = ancestor.parent_id.as_deref(),
        }
    }
    "direct"
}

fn cache_call(span: &Span) -> Call<'_> {
    let (alias, op, key) = cache_op(span);
    let exact = item_key(span, "cache.key");
    let group = format!("{alias} {op} {key}").trim_end().to_owned();
    Call {
        span,
        title: group.clone(),
        group,
        exact: format!("{alias} {op} {}", exact.unwrap_or_default()),
        read: exact.is_some() && CACHE_READS.contains(&op.as_str()),
    }
}

fn redis_call(span: &Span) -> Call<'_> {
    let (alias, command, key) = redis_command(span);
    let exact = item_key(span, "redis.key");
    let title = format!("{command} {key}").trim_end().to_owned();
    Call {
        span,
        // Two clients (databases) apart: the same command on each is not one group.
        group: format!("{alias} {title}"),
        title,
        exact: format!("{alias} {command} {}", exact.unwrap_or_default()),
        read: exact.is_some() && CACHE_READS.contains(&command.to_lowercase().as_str()),
    }
}

/// Whether repeated calls cost at least `min_ms` together, by their median: the first call of a request often pays
/// for opening the connection, and that is not what repeating them costs.
fn costly(spans: &[&Span], min_ms: i64) -> bool {
    let mut durations: Vec<i64> = spans.iter().map(|span| span.duration).collect();
    durations.sort_unstable();
    let median = durations.get(durations.len() / 2).copied().unwrap_or(0);
    median.saturating_mul(spans.len() as i64) >= min_ms.saturating_mul(1000)
}

pub fn headline(message: &str) -> String {
    let first = message
        .lines()
        .map(|line| line.trim_end_matches('\r'))
        .find(|line| !line.trim().is_empty())
        .unwrap_or("");
    let text = WHITESPACE.replace_all(first, " ").trim().to_owned();
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= TITLE_LIMIT {
        return text;
    }
    let cut: String = chars[..TITLE_LIMIT - 1].iter().collect();
    let space = cut.rfind(' ');
    let kept = match space {
        Some(at) if cut[..at].chars().count() > TITLE_LIMIT / 2 => &cut[..at],
        _ => cut.as_str(),
    };
    format!("{}…", kept.trim_end_matches([' ', ',', '.', ':', ';']))
}

fn error_issues(trace: &Trace) -> Vec<Issue> {
    trace
        .errors
        .iter()
        .map(|error| {
            let frames = error
                .get("frames")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let frame = frames
                .iter()
                .rev()
                .find(|frame| frame.get("in_app") == Some(&Value::Bool(true)))
                .or_else(|| frames.last());
            let field = |frame: &Value, key: &str| py_str(frame.get(key));
            let culprit = frame.map(|f| {
                format!(
                    "{}:{} in {}",
                    field(f, "filename"),
                    field(f, "lineno"),
                    field(f, "function")
                )
            });
            let location =
                frame.map(|f| format!("{}.{}", field(f, "module"), field(f, "function")));
            let kind = py_str(error.get("type"));
            let message = py_str(error.get("message"));
            let span_ids = error
                .get("span_id")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .into_iter()
                .collect();
            issue(
                issue_key("error", &[Some(&kind), location.as_deref()]),
                "error",
                // The message's first line that says something: a driver's may start with blank lines.
                headline(&format!(
                    "{}: {}",
                    kind.strip_prefix("builtins.").unwrap_or(&kind),
                    message.trim_start()
                )),
                culprit,
                None,
                1,
                span_ids,
            )
        })
        .collect()
}

// ---------- transactions ----------

/// Span id -> the outer transaction it ran in; on_commit callbacks (run after COMMIT) don't count.
fn in_transactions(trace: &Trace) -> Vec<(&Span, &Span)> {
    let by_id: HashMap<&str, &Span> = trace
        .spans
        .iter()
        .map(|span| (span.id.as_str(), span))
        .collect();
    let mut found = Vec::new();
    for span in &trace.spans {
        let mut outer = None;
        let mut parent = span
            .parent_id
            .as_deref()
            .and_then(|id| by_id.get(id).copied());
        while let Some(current) = parent {
            if truthy(current.attrs.get("db.transaction.on_commit")) {
                outer = None;
                break;
            }
            if current.kind == "transaction"
                && !truthy(current.attrs.get("db.transaction.savepoint"))
            {
                outer = Some(current);
            }
            parent = current
                .parent_id
                .as_deref()
                .and_then(|id| by_id.get(id).copied());
        }
        if let Some(outer) = outer {
            found.push((span, outer));
        }
    }
    found
}

fn transaction_issues(trace: &Trace, thresholds: &Thresholds) -> Vec<Issue> {
    let mut issues = Vec::new();
    for span in &trace.spans {
        let outer =
            span.kind == "transaction" && !truthy(span.attrs.get("db.transaction.savepoint"));
        if outer && span.duration >= thresholds.long_transaction_ms * 1000 {
            let culprit_text = text(&span.attrs, "code.origin");
            let alias = py_str(span.attrs.get("db.alias"));
            issues.push(issue(
                issue_key(
                    "long-transaction",
                    &[
                        Some(&alias),
                        culprit_key(culprit_text.as_deref()).as_deref(),
                    ],
                ),
                "long-transaction",
                format!(
                    "Long transaction: {} ms on {alias}",
                    milliseconds(span.duration)
                ),
                culprit_text,
                Some(
                    if text(&span.attrs, "db.client").as_deref() == Some("sqlalchemy") {
                        LONG_TRANSACTION_SQLALCHEMY
                    } else {
                        LONG_TRANSACTION
                    },
                ),
                1,
                vec![span.id.clone()],
            ));
        }
    }
    let mut order: Vec<(String, Option<String>, String)> = Vec::new();
    let mut groups: HashMap<(String, Option<String>, String), Vec<&Span>> = HashMap::new();
    for (span, outer) in in_transactions(trace) {
        if in_transaction(&span.kind).is_none() || truthy(span.attrs.get("task.eager")) {
            continue;
        }
        let key = (
            span.kind.clone(),
            culprit(&[span]),
            py_str(outer.attrs.get("db.client")),
        );
        if !groups.contains_key(&key) {
            order.push(key.clone());
        }
        groups.entry(key).or_default().push(span);
    }
    for key in order {
        let spans = &groups[&key];
        let (kind, culprit_text, client) = key;
        let Some((title, django, sqlalchemy)) = in_transaction(&kind) else {
            continue;
        };
        issues.push(issue(
            issue_key(
                "in-transaction",
                &[Some(&kind), culprit_key(culprit_text.as_deref()).as_deref()],
            ),
            "in-transaction",
            format!("{title} · {}", spans[0].name),
            culprit_text,
            Some(if client == "sqlalchemy" {
                sqlalchemy
            } else {
                django
            }),
            spans.len(),
            spans.iter().map(|span| span.id.clone()).collect(),
        ));
    }
    issues
}

// ---------- htmx (tracepanel/integrations/htmx.py) ----------

fn htmx_issues(trace: &Trace) -> Vec<Issue> {
    let attrs = &trace.attrs;
    if !truthy(attrs.get("htmx.request")) {
        return Vec::new();
    }
    let method = or_default(attrs, "http.method", "GET");
    let route = if truthy(attrs.get("http.route")) {
        py_str(attrs.get("http.route"))
    } else {
        or_default(attrs, "http.path", "")
    };
    let view = text(attrs, "code.view");
    let mut found: Vec<(&str, String, &str)> = Vec::new();
    if let Some(location) = text(attrs, "htmx.redirected_to") {
        found.push((
            "redirect",
            format!(
                "htmx request redirected · {} to {location}",
                py_str(attrs.get("http.status_code"))
            ),
            REDIRECT_HINT,
        ));
    }
    if truthy(attrs.get("htmx.full_page")) {
        found.push((
            "full-page",
            format!("Whole page sent to htmx · {method} {route}"),
            FULL_PAGE_HINT,
        ));
    }
    found
        .into_iter()
        .map(|(what, title, hint)| {
            issue(
                issue_key("htmx", &[Some(what), Some(&method), Some(&route)]),
                "htmx",
                title,
                view.clone(),
                Some(hint),
                1,
                Vec::new(),
            )
        })
        .collect()
}

/// A received trace, made ready for the store: its OpenTelemetry spans mapped to tracepanel's kinds (an older SDK's
/// storage calls too), then its issues found, in its rows and in its document, which the console shows.
pub fn apply(received: &mut tracepanel_protocol::Received, thresholds: &Thresholds) {
    otel::normalize(received);
    storage::normalize(received);
    let issues = analyze(&received.trace, thresholds);
    if issues.is_empty() {
        return;
    }
    if let Some(doc) = with_issues(&received.doc, &issues) {
        received.doc = doc;
    }
    received.trace.issues = issues;
}

/// The document with its issues in: its other fields as they came, unparsed (a trace's document is most of its size,
/// and a whole tree of it cost three times what finding the issues did). Its keys sorted, as before.
fn with_issues(doc: &str, issues: &[Issue]) -> Option<String> {
    let mut fields: BTreeMap<String, &RawValue> = serde_json::from_str(doc).ok()?;
    let issues = serde_json::value::to_raw_value(issues).ok()?;
    fields.insert("issues".to_owned(), &issues);
    serde_json::to_string(&fields).ok()
}

/// Issues in a finished trace: errors first, then the rest by occurrence count.
pub fn analyze(trace: &Trace, thresholds: &Thresholds) -> Vec<Issue> {
    let mut found = calls::operation_issues(trace, thresholds);
    found.extend(transaction_issues(trace, thresholds));
    found.extend(htmx_issues(trace));
    found.extend(large_result_issues(trace, thresholds));
    found.extend(waits::queue_issues(trace, thresholds));
    found.extend(waits::blocking_issues(trace));
    // A stable sort, as Python's sorted().
    found.sort_by_key(|issue| -issue.count);
    let mut issues = error_issues(trace);
    issues.extend(found);
    issues
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn milliseconds_round_half_to_even() {
        assert_eq!(
            [
                milliseconds(2500),
                milliseconds(3500),
                milliseconds(2501),
                milliseconds(1499)
            ],
            [2, 4, 3, 1]
        );
    }

    #[test]
    fn culprit_keys_drop_line_numbers() {
        assert_eq!(
            culprit_key(Some("blog/views.py:21 in post_list")).as_deref(),
            Some("blog/views.py in post_list")
        );
    }

    #[test]
    fn by_pk_matches_qualified_and_plain_lookups() {
        assert!(BY_PK.is_match("SELECT name FROM authors WHERE authors.id = ?"));
        assert!(BY_PK.is_match("SELECT name FROM authors WHERE id = ?"));
        assert!(BY_PK.is_match(r#"SELECT * FROM "auth_user" WHERE "auth_user"."id" = %s"#));
        assert!(BY_PK.is_match("SELECT * FROM users WHERE id = $1"));
        assert!(!BY_PK.is_match("SELECT * FROM users WHERE author_id = ?"));
    }

    #[test]
    fn by_pk_matches_every_quoting_and_placeholder() {
        // SQL Server as Django's mssql backend writes it, MySQL's backticks, then each driver's placeholder.
        for statement in [
            "SELECT TOP 21 [shop_customer].[id], [shop_customer].[user_id] FROM [shop_customer] \
             WHERE [shop_customer].[id] = %s",
            "SELECT [auth_user].[id] FROM [auth_user] WHERE [id] = %s",
            "SELECT `auth_user`.`id` FROM `auth_user` WHERE `auth_user`.`id` = %s LIMIT 21",
            "SELECT * FROM users WHERE users.id = %(id_1)s",
            "SELECT * FROM users WHERE users.id = ?1",
            "SELECT * FROM users WHERE users.id = @P1",
            "SELECT * FROM users WHERE users.id = @id",
            "SELECT * FROM users WHERE users.id = :1",
            "SELECT * FROM users WHERE users.id = :id_1",
        ] {
            assert!(BY_PK.is_match(statement), "{statement}");
        }

        assert!(!BY_PK.is_match(
            "SELECT [shop_order].[id] FROM [shop_order] WHERE [shop_order].[customer_id] = %s"
        ));
    }

    #[test]
    fn a_document_gets_its_issues_and_keeps_the_rest_as_it_came() {
        let issue = Issue {
            fingerprint: "f".into(),
            fingerprint_version: 1,
            kind: "n+1".into(),
            title: "N+1".into(),
            culprit: None,
            hint: None,
            count: 3,
            span_ids: vec!["s".into()],
        };
        let doc = r#"{"name":"GET /","issues":[],"attrs":{"z":1,"a":"\u00e9 1.50"}}"#;

        assert_eq!(
            with_issues(doc, std::slice::from_ref(&issue)).as_deref(),
            Some(
                r#"{"attrs":{"z":1,"a":"\u00e9 1.50"},"issues":[{"fingerprint":"f","fingerprint_version":1,"kind":"n+1","title":"N+1","culprit":null,"hint":null,"count":3,"span_ids":["s"]}],"name":"GET /"}"#
            )
        );
        assert_eq!(with_issues("not json", &[issue]), None);
    }

    #[test]
    fn headlines_cut_at_a_word() {
        assert_eq!(headline("ValueError: bad\n  detail"), "ValueError: bad");
        let long = format!("Error: {}", "word ".repeat(60));
        let title = headline(&long);
        assert!(title.ends_with("word…") && title.chars().count() <= TITLE_LIMIT);
    }

    /// A request whose spans are these (kind, name, attrs, duration in µs).
    fn request(spans: &[(&str, &str, Value, i64)]) -> Trace {
        let spans: Vec<Value> = spans
            .iter()
            .enumerate()
            .map(|(n, (kind, name, attrs, duration))| {
                serde_json::json!({
                    "id": format!("s{n}"), "kind": kind, "name": name, "start": n, "duration": duration,
                    "attrs": attrs,
                })
            })
            .collect();
        serde_json::from_value(serde_json::json!({
            "id": "t", "kind": "http", "name": "GET /", "start": 0, "spans": spans,
        }))
        .unwrap()
    }

    fn get(url: &str) -> (&'static str, &'static str, Value, i64) {
        let attrs = serde_json::json!({
            "http.request.method": "GET", "url.full": url, "code.origin": "app/views.py:12 in feed",
        });
        ("http.client", "GET", attrs, 1000)
    }

    fn cache(op: &str, key: Value) -> (&'static str, &'static str, Value, i64) {
        let attrs = serde_json::json!({
            "cache.alias": "redis", "cache.op": op, "cache.key": key, "code.origin": "app/views.py:20 in feed",
        });
        // 3 ms: a cache on a Redis over the network, where even two of the same cost more than 5 ms.
        ("cache", "redis", attrs, 3000)
    }

    #[test]
    fn redis_commands_under_a_cache_call_are_the_cache_s_issue() {
        let mut trace = request(&[
            cache("get", "user:1".into()),
            redis("GET", "user:1".into()),
            cache("get", "user:2".into()),
            redis("GET", "user:2".into()),
            cache("get", "user:3".into()),
            redis("GET", "user:3".into()),
        ]);
        // Each GET under the cache get before it, as the SDK nests them.
        for index in [1, 3, 5] {
            let parent = trace.spans[index - 1].id.clone();
            trace.spans[index].parent_id = Some(parent);
        }

        assert_eq!(
            found(&trace),
            [(
                "n+1".to_owned(),
                "N+1: 3 similar cache calls · redis get user:{id}".to_owned(),
                3
            )]
        );
        assert_eq!(
            trace
                .spans
                .iter()
                .map(|span| redis_via(&trace, span))
                .collect::<Vec<_>>(),
            ["direct", "cache", "direct", "cache", "direct", "cache"]
        );
    }

    fn redis(command: &str, key: Value) -> (&'static str, &'static str, Value, i64) {
        let attrs = serde_json::json!({
            "db.system": "redis", "db.operation": command, "redis.alias": "redis", "redis.key": key,
            "code.origin": "app/views.py:30 in feed",
        });
        ("redis", "GET", attrs, 3000)
    }

    #[test]
    fn cheap_repeats_of_an_in_memory_store_are_no_issue() {
        // Three GETs of 0.2 ms each, and a first one that opened the connection: 0.6 ms by the median, under 5 ms.
        let mut spans = vec![
            redis("GET", "user:1".into()),
            redis("GET", "user:2".into()),
            redis("GET", "user:3".into()),
        ];
        spans[0].3 = 10_000;
        for span in &mut spans[1..] {
            span.3 = 200;
        }
        let cheap = request(&spans);

        assert_eq!(found(&cheap), []);
        // The same at 3 ms each (a Redis over the network): an N+1.
        assert_eq!(
            found(&request(&[
                redis("GET", "user:1".into()),
                redis("GET", "user:2".into()),
                redis("GET", "user:3".into())
            ]))
            .len(),
            1
        );
    }

    fn found(trace: &Trace) -> Vec<(String, String, i64)> {
        analyze(trace, &Thresholds::default())
            .into_iter()
            .map(|issue| (issue.kind, issue.title, issue.count))
            .collect()
    }

    /// A query a template made as it rendered (line 4 of blog/list.html), for row `n`, through `client`.
    fn rendered(
        statement: &str,
        client: &str,
        n: usize,
    ) -> (&'static str, &'static str, Value, i64) {
        let attrs = serde_json::json!({
            "db.statement": statement, "db.fingerprint": statement, "db.params_hash": format!("p{n}"),
            "db.client": client, "code.origin": "blog/views.py:9 in post_list", "code.template": "blog/list.html",
            "code.template_line": 4,
        });
        ("sql", "SELECT", attrs, 1000)
    }

    fn hints(spans: &[(&str, &str, Value, i64)]) -> Vec<(Option<String>, Option<String>)> {
        analyze(&request(spans), &Thresholds::default())
            .into_iter()
            .map(|issue| (issue.culprit, issue.hint))
            .collect()
    }

    #[test]
    fn an_n_plus_one_a_template_makes_names_it_and_its_line() {
        let author = r#"SELECT "author"."name" FROM "author" WHERE "author"."id" = %s LIMIT 21"#;
        let tags = r#"SELECT "tag"."name" FROM "tag" WHERE "tag"."post_id" = %s"#;
        let by_template = |statement: &str, client: &str| {
            (0..3)
                .map(|n| rendered(statement, client, n))
                .collect::<Vec<_>>()
        };
        let lead = "The template `blog/list.html` makes these queries as it renders (line 4), one per row it shows. ";
        let culprit =
            Some("blog/list.html (rendered from blog/views.py:9 in post_list)".to_owned());

        assert_eq!(
            hints(&by_template(author, "django")),
            [(culprit.clone(), Some(format!("{lead}{SELECT_RELATED}")))]
        );
        assert_eq!(
            hints(&by_template(tags, "django")),
            [(culprit.clone(), Some(format!("{lead}{PREFETCH_RELATED}")))]
        );
        assert_eq!(
            hints(&by_template(author, "")),
            [(culprit, Some(format!("{lead}{N_PLUS_ONE_IN_TEMPLATE}")))]
        );

        // Without its line, the template alone; made by a view's code, the hint as it was.
        let mut unlined = by_template(author, "django");
        for (_, _, attrs, _) in &mut unlined {
            attrs["code.template_line"] = Value::Null;
        }
        let mut in_view = by_template(author, "django");
        for (_, _, attrs, _) in &mut in_view {
            attrs["code.template"] = Value::Null;
        }

        assert_eq!(
            hints(&unlined)[0].1.as_deref(),
            Some(
                format!(
                    "The template `blog/list.html` makes these queries as it renders, one per row it shows. \
                     {SELECT_RELATED}"
                )
                .as_str()
            )
        );
        assert_eq!(hints(&in_view)[0].1.as_deref(), Some(SELECT_RELATED));
    }

    #[test]
    fn a_graphql_n_plus_one_names_the_dataloader_of_its_library() {
        let author = r#"SELECT "author"."name" FROM "author" WHERE "author"."id" = %s LIMIT 21"#;
        let hint = |attrs: Value| {
            let mut trace = request(
                &(0..3)
                    .map(|n| {
                        let attrs = serde_json::json!({
                            "db.statement": author, "db.fingerprint": author, "db.params_hash": format!("p{n}"),
                            "db.client": "django", "code.origin": "blog/schema.py:30 in resolve_author",
                        });
                        ("sql", "SELECT", attrs, 1000)
                    })
                    .collect::<Vec<_>>(),
            );
            trace.attrs = serde_json::from_value(attrs).unwrap();
            analyze(&trace, &Thresholds::default())[0]
                .hint
                .clone()
                .unwrap()
        };
        let graphql = |library: Value| {
            hint(
                serde_json::json!({"graphql.operation": "query PostList", "graphql.library": library}),
            )
        };
        let batch =
            "In GraphQL, a resolver runs once per object: batch these lookups with a DataLoader";

        assert_eq!(
            graphql("strawberry".into()),
            format!(
                "{SELECT_RELATED} {batch} (`strawberry.dataloader`), or prefetch in the parent resolver."
            )
        );
        assert_eq!(
            graphql("graphene".into()),
            format!(
                "{SELECT_RELATED} {batch} (graphql-sync-dataloaders' `SyncDataLoader` in graphene-django's sync \
                 view, aiodataloader in an async one), or prefetch in the parent resolver."
            )
        );

        // A library the agent doesn't know, or an SDK that doesn't say: a DataLoader, none named.
        let unnamed = format!("{SELECT_RELATED} {batch}, or prefetch in the parent resolver.");

        assert_eq!(graphql("graphql-java".into()), unnamed);
        assert_eq!(graphql(Value::Null), unnamed);
        assert_eq!(
            hint(serde_json::json!({"graphql.operation": "query PostList"})),
            unnamed
        );

        // Not a GraphQL request: no DataLoader.
        assert_eq!(hint(serde_json::json!({})), SELECT_RELATED);
    }

    #[test]
    fn templates_name_the_item_as_id() {
        assert_eq!(
            [
                template("users/42/orders"),
                template("user:42:profile"),
                template("files/0b9f6c1e-3c1a-4c1e-9f1e-2a8f8a1d3b4c"),
                template("blobs/9f86d081884c7d659a2feaa0c55ad015"),
                template("v2/items"),
            ],
            [
                "users/{id}/orders",
                "user:{id}:profile",
                "files/{id}",
                "blobs/{id}",
                "v2/items",
            ]
        );
    }

    #[test]
    fn a_call_per_item_is_an_n_plus_one() {
        let trace = request(&[
            get("https://api.example.com/users/1?fields=name"),
            get("https://api.example.com/users/2?fields=name"),
            get("https://api.example.com/users/3?fields=name"),
            cache("get", "user:1".into()),
            cache("get", "user:2".into()),
            cache("get", "user:3".into()),
        ]);

        assert_eq!(
            found(&trace),
            [
                (
                    "n+1".to_owned(),
                    "N+1: 3 similar calls · GET api.example.com/users/{id}".to_owned(),
                    3
                ),
                (
                    "n+1".to_owned(),
                    "N+1: 3 similar cache calls · redis get user:{id}".to_owned(),
                    3
                ),
            ]
        );
    }

    #[test]
    fn the_same_read_twice_is_a_duplicate_and_a_write_is_not() {
        let trace = request(&[
            get("https://api.example.com/rates"),
            get("https://api.example.com/rates"),
            cache("get", "settings".into()),
            cache("get", "settings".into()),
            cache("incr", "hits".into()),
            cache("incr", "hits".into()),
        ]);

        assert_eq!(
            found(&trace),
            [
                (
                    "duplicates".to_owned(),
                    "Duplicate calls: 2 identical · GET api.example.com/rates".to_owned(),
                    2
                ),
                (
                    "duplicates".to_owned(),
                    "Duplicate cache calls: 2 identical · redis get settings".to_owned(),
                    2
                ),
            ]
        );
    }

    #[test]
    fn a_call_recorded_by_two_layers_is_one_call() {
        // Next.js's fetch span, and undici's span for the same request under it.
        let mut nested = request(&[
            get("https://api.example.com/rates"),
            get("https://api.example.com/rates"),
        ]);
        nested.spans[1].parent_id = Some(nested.spans[0].id.clone());

        assert_eq!(found(&nested), []);

        // The same request twice, side by side: still a duplicate.
        let siblings = request(&[
            get("https://api.example.com/rates"),
            get("https://api.example.com/rates"),
        ]);

        assert_eq!(
            found(&siblings),
            [(
                "duplicates".to_owned(),
                "Duplicate calls: 2 identical · GET api.example.com/rates".to_owned(),
                2
            )]
        );
    }

    #[test]
    fn single_calls_and_calls_from_library_code_are_no_issue() {
        // Made by a library, with no project frame to point at.
        let mut library = get("https://auth.example.com/keys");
        library.2 = serde_json::json!({"http.request.method": "GET", "url.full": "https://auth.example.com/keys"});
        let trace = request(&[
            get("https://api.example.com/users/1"),
            get("https://api.example.com/teams/1"),
            cache("get_many", 3.into()),
            library.clone(),
            library.clone(),
            library,
        ]);

        assert_eq!(found(&trace), []);
    }

    #[test]
    fn a_loop_of_sql_server_lookups_in_library_code_is_the_view_s_n_plus_one() {
        // A product page on SQL Server: a library's loop looks up each customer, then its user, by key (the
        // statements as Django's mssql backend writes them). No project frame: the issue points at the view.
        let customer = "SELECT TOP 21 [shop_customer].[id], [shop_customer].[user_id] FROM [shop_customer] \
                        WHERE [shop_customer].[id] = %s";
        let user = "SELECT TOP 21 [auth_user].[id], [auth_user].[username] FROM [auth_user] \
                    WHERE [auth_user].[id] = %s";
        let lookup = |statement: &str, name: &'static str, n: usize| {
            let attrs = serde_json::json!({
                "db.statement": statement, "db.fingerprint": statement, "db.params_hash": format!("p{n}"),
                "db.client": "django", "db.vendor": "microsoft", "code.origin": null,
                "code.caller": "reviews/widgets.py:40 in render",
            });
            ("sql", name, attrs, 1000)
        };
        let spans: Vec<_> = (0..7)
            .flat_map(|n| {
                [
                    lookup(customer, "SELECT shop_customer", n),
                    lookup(user, "SELECT auth_user", n),
                ]
            })
            .collect();
        let mut trace = request(&spans);
        trace
            .attrs
            .insert("code.view".into(), "shop.views.product_detail".into());

        let issues: Vec<_> = analyze(&trace, &Thresholds::default())
            .into_iter()
            .map(|issue| {
                (
                    issue.kind,
                    issue.title,
                    issue.culprit,
                    issue.hint,
                    issue.count,
                )
            })
            .collect();

        let culprit = Some("shop.views.product_detail (in library code)".to_owned());
        assert_eq!(
            issues,
            [
                (
                    "n+1".to_owned(),
                    "N+1: 7 similar queries · SELECT shop_customer".to_owned(),
                    culprit.clone(),
                    Some(SELECT_RELATED.to_owned()),
                    7
                ),
                (
                    "n+1".to_owned(),
                    "N+1: 7 similar queries · SELECT auth_user".to_owned(),
                    culprit,
                    Some(SELECT_RELATED.to_owned()),
                    7
                ),
            ]
        );
    }

    #[test]
    fn a_select_without_a_limit_that_returned_many_rows() {
        let query = |statement: &str, rows: i64| {
            let attrs = serde_json::json!({
                "db.statement": statement, "db.fingerprint": statement, "db.response.returned_rows": rows,
                "code.origin": "app/views.py:14 in export",
            });
            ("sql", "SELECT product", attrs, 2_000)
        };
        let trace = request(&[
            query(
                r#"SELECT "product"."id", "product"."name" FROM "product""#,
                25_000,
            ),
            // Bounded, few, or not a read: nothing.
            query("SELECT * FROM product LIMIT 50", 50),
            query("SELECT * FROM product LIMIT 5000", 5000),
            // SQL Server's bounds, as Django's mssql backend writes them.
            query("SELECT TOP 5000 [product].[id] FROM [product]", 5000),
            query(
                "SELECT [product].[id] FROM [product] ORDER BY [product].[id] ASC  OFFSET 20 ROWS \
                 FETCH FIRST 5000 ROWS ONLY",
                5000,
            ),
            query("SELECT * FROM category", 12),
            query("UPDATE product SET price = price * 2", 25_000),
        ]);

        let issues = analyze(&trace, &Thresholds::default());
        assert_eq!(
            issues
                .iter()
                .map(|issue| (
                    issue.kind.as_str(),
                    issue.title.as_str(),
                    issue.culprit.as_deref()
                ))
                .collect::<Vec<_>>(),
            [(
                "large-result",
                "Large result: 25000 rows · SELECT product",
                Some("app/views.py:14 in export")
            )]
        );
        let relaxed = Thresholds {
            large_result_rows: 50_000,
            ..Thresholds::default()
        };
        assert!(analyze(&trace, &relaxed).is_empty());
    }

    #[test]
    fn a_slow_like_with_a_leading_wildcard_says_why_no_index_helps() {
        let slow = |statement: &str, params: Value| {
            let attrs = serde_json::json!({
                "db.statement": statement, "db.fingerprint": statement, "db.params": params,
                "code.origin": "app/views.py:9 in search",
            });
            request(&[("sql", "SELECT product", attrs, 300_000)])
        };
        let hint = |trace: &Trace| {
            analyze(trace, &Thresholds::default())[0]
                .hint
                .clone()
                .unwrap_or_default()
        };

        // Django's icontains: the pattern in the parameter.
        let icontains = slow(
            r#"SELECT * FROM "product" WHERE UPPER("product"."name"::text) LIKE UPPER(%s)"#,
            serde_json::json!(["%lamp%"]),
        );
        assert!(hint(&icontains).starts_with(SLOW_SQL));
        assert!(hint(&icontains).ends_with(LIKE_HINT));
        // The pattern written into the statement.
        assert!(
            hint(&slow(
                "SELECT * FROM product WHERE name LIKE '%lamp'",
                Value::Null
            ))
            .ends_with(LIKE_HINT)
        );

        // A prefix match can use an index; and a slow query without LIKE is only slow.
        assert_eq!(
            hint(&slow(
                "SELECT * FROM product WHERE name LIKE %s",
                serde_json::json!(["lamp%"])
            )),
            SLOW_SQL
        );
        assert_eq!(
            hint(&slow(
                "SELECT * FROM product WHERE price > %s",
                serde_json::json!(["%"])
            )),
            SLOW_SQL
        );
    }

    #[test]
    fn a_task_that_waited_for_a_worker() {
        let task = |waited: i64| -> Trace {
            serde_json::from_value(serde_json::json!({
                "id": "t", "kind": "task", "name": "shop.tasks.send_receipt", "start": 0,
                "attrs": {"task.queue_wait": waited, "task.queue": "emails"},
            }))
            .unwrap()
        };

        let issues = analyze(&task(4_200_000), &Thresholds::default());
        assert_eq!(
            issues
                .iter()
                .map(|issue| (
                    issue.kind.as_str(),
                    issue.title.as_str(),
                    issue.culprit.as_deref()
                ))
                .collect::<Vec<_>>(),
            [(
                "queue-wait",
                "Queue wait: 4200 ms in emails · shop.tasks.send_receipt",
                Some("shop.tasks.send_receipt")
            )]
        );

        // Under the threshold, or not a task: nothing.
        assert!(analyze(&task(900_000), &Thresholds::default()).is_empty());
        let relaxed = Thresholds {
            queue_wait_ms: 5000,
            ..Thresholds::default()
        };
        assert!(analyze(&task(4_200_000), &relaxed).is_empty());
    }

    #[test]
    fn a_blocking_call_on_the_event_loop() {
        let blocking = |url: &'static str, origin: &str, duration: i64| {
            let mut call = get(url);
            call.2["code.blocks_event_loop"] = Value::Bool(true);
            call.2["code.origin"] = Value::from(origin);
            call.3 = duration;
            call
        };
        let trace = request(&[
            blocking(
                "https://pay.example.com/charges",
                "app/views.py:30 in checkout",
                4_000,
            ),
            blocking(
                "https://pay.example.com/tax",
                "app/views.py:30 in checkout",
                3_000,
            ),
            // Too quick to matter, alone at its line.
            blocking(
                "https://pay.example.com/ping",
                "app/views.py:40 in checkout",
                200,
            ),
            // Awaited: not on the loop.
            get("https://pay.example.com/refunds"),
        ]);

        assert_eq!(
            found(&trace),
            [(
                "blocking-call".to_owned(),
                "Blocking call in async code: 2 HTTP calls, 7 ms · GET".to_owned(),
                2
            )]
        );
        let issue = &analyze(&trace, &Thresholds::default())[0];
        assert_eq!(
            (issue.culprit.as_deref(), issue.span_ids.as_slice()),
            (
                Some("app/views.py:30 in checkout"),
                ["s0".to_owned(), "s1".to_owned()].as_slice()
            )
        );
        assert!(
            issue
                .hint
                .as_deref()
                .unwrap_or_default()
                .contains("httpx.AsyncClient")
        );
    }

    #[test]
    fn a_slow_http_call_by_its_threshold() {
        let mut slow = get("https://pay.example.com/charges");
        slow.3 = 750_000;
        let trace = request(&[slow, get("https://pay.example.com/refunds")]);

        assert_eq!(
            found(&trace),
            [(
                "slow-http".to_owned(),
                "Slow HTTP call: 750 ms · GET pay.example.com/charges".to_owned(),
                1
            )]
        );

        let relaxed = Thresholds {
            slow_http_ms: 1000,
            ..Thresholds::default()
        };
        assert!(analyze(&trace, &relaxed).is_empty());
    }

    #[test]
    fn redis_commands_have_the_issues_of_cache_calls() {
        let trace = request(&[
            redis("GET", "post:1:views".into()),
            redis("GET", "post:2:views".into()),
            redis("GET", "post:3:views".into()),
            redis("HGETALL", "settings".into()),
            redis("HGETALL", "settings".into()),
            redis("INCR", "hits".into()),
            redis("INCR", "hits".into()),
            // A pipeline's key is how many commands it sent: no item, no group of items.
            redis("PIPELINE", 3.into()),
        ]);

        assert_eq!(
            found(&trace),
            [
                (
                    "n+1".to_owned(),
                    "N+1: 3 similar Redis commands · GET post:{id}:views".to_owned(),
                    3
                ),
                (
                    "duplicates".to_owned(),
                    "Duplicate Redis commands: 2 identical · HGETALL settings".to_owned(),
                    2
                ),
            ]
        );
    }

    /// An operation span of project code: (kind, name, attrs, duration in µs).
    fn op(
        kind: &'static str,
        name: &'static str,
        mut attrs: Value,
        duration: i64,
    ) -> (&'static str, &'static str, Value, i64) {
        attrs["code.origin"] = Value::from("app/views.py:40 in feed");
        (kind, name, attrs, duration)
    }

    #[test]
    fn a_datastore_gets_n_plus_one_and_duplicate_reads_from_its_family() {
        let find = |id: i64| {
            op(
                "mongodb",
                "find users",
                serde_json::json!({"db.system": "mongodb", "db.operation": "find", "db.collection.name": "users",
                                   "db.namespace": "shop", "db.statement": format!("{{\"filter\": {{\"_id\": {id}}}}}")}),
                2000,
            )
        };
        assert_eq!(
            found(&request(&[find(1), find(2), find(3)])),
            [(
                "n+1".to_owned(),
                "N+1: 3 similar MongoDB commands · find users".to_owned(),
                3
            )]
        );
        // The same read twice: a duplicate; an insert twice is two actions.
        let insert = op(
            "mongodb",
            "insert users",
            serde_json::json!({"db.system": "mongodb", "db.operation": "insert", "db.collection.name": "users",
                               "db.statement": "{\"documents\": [{\"n\": 1}]}"}),
            2000,
        );
        assert_eq!(
            found(&request(&[find(7), find(7), insert.clone(), insert])),
            [(
                "duplicates".to_owned(),
                "Duplicate MongoDB commands: 2 identical · find users".to_owned(),
                2
            )]
        );
    }

    #[test]
    fn a_datastore_query_with_its_values_apart_is_the_same_query_only_with_the_same_values() {
        // As an SDK records a query: its shape in the statement, its values local (db.params) and hashed.
        let find = |hash: &str| {
            op(
                "mongodb",
                "find users",
                serde_json::json!({"db.system": "mongodb", "db.operation": "find", "db.collection.name": "users",
                                   "db.statement": "{\"filter\": {\"_id\": \"?\"}}", "db.params_hash": hash}),
                2000,
            )
        };
        assert_eq!(
            found(&request(&[find("a1"), find("b2"), find("c3")])),
            [(
                "n+1".to_owned(),
                "N+1: 3 similar MongoDB commands · find users".to_owned(),
                3
            )]
        );
        assert_eq!(
            found(&request(&[find("a1"), find("a1")])),
            [(
                "duplicates".to_owned(),
                "Duplicate MongoDB commands: 2 identical · find users".to_owned(),
                2
            )]
        );
    }

    #[test]
    fn a_publish_per_item_is_an_n_plus_one_and_never_a_duplicate() {
        let publish = || {
            op(
                "kafka",
                "publish orders",
                serde_json::json!({"messaging.system": "kafka", "messaging.operation": "publish",
                                   "messaging.destination.name": "orders"}),
                1000,
            )
        };
        assert_eq!(
            found(&request(&[publish(), publish(), publish()])),
            [(
                "n+1".to_owned(),
                "N+1: 3 similar Kafka messages · publish orders".to_owned(),
                3
            )]
        );
        assert_eq!(found(&request(&[publish(), publish()])), []);
    }

    #[test]
    fn a_slow_grpc_call_and_cheap_memcached_repeats() {
        let call = op(
            "grpc",
            "Users/Get",
            serde_json::json!({"rpc.system": "grpc", "rpc.service": "Users", "rpc.method": "Get"}),
            700_000,
        );
        assert_eq!(
            found(&request(&[call])),
            [(
                "slow-call".to_owned(),
                "Slow gRPC call: 700 ms · Users/Get".to_owned(),
                1
            )]
        );
        // Three Memcached gets of 0.2 ms: under n_plus_one_min_ms, no issue.
        let get = |key: &str| {
            op(
                "memcached",
                "get",
                serde_json::json!({"db.system": "memcached", "db.operation": "get",
                                   "db.statement": format!("get {key}")}),
                200,
            )
        };
        assert_eq!(
            found(&request(&[get("user:1"), get("user:2"), get("user:3")])),
            []
        );
    }

    #[test]
    fn a_slow_mongodb_query_names_the_index_its_filter_needs() {
        let find = op(
            "mongodb",
            "find users",
            serde_json::json!({"db.system": "mongodb", "db.operation": "find", "db.collection.name": "users",
                               "db.statement": "{\"find\": \"users\", \"filter\": {\"$or\": [{\"email\": \"?\"}, {\"phone\": \"?\"}], \"active\": \"?\"}, \"sort\": {\"created\": -1}}"}),
            150_000,
        );
        let issues = analyze(&request(&[find]), &Thresholds::default());

        assert_eq!(
            issues
                .iter()
                .map(|issue| (issue.kind.as_str(), issue.title.as_str()))
                .collect::<Vec<_>>(),
            [("slow-call", "Slow MongoDB query: 150 ms · find users")]
        );
        assert!(
            issues[0]
                .hint
                .as_deref()
                .unwrap_or_default()
                .ends_with(
                    "(COLLSCAN in `explain()`) when no index covers the filter: \
                     `db.users.createIndex({\"email\": 1, \"phone\": 1, \"active\": 1, \"created\": 1})`."
                ),
            "{:?}",
            issues[0].hint
        );
        // By _id alone: always indexed, the general hint.
        let by_id = op(
            "mongodb",
            "find users",
            serde_json::json!({"db.system": "mongodb", "db.operation": "find", "db.collection.name": "users",
                               "db.statement": "{\"find\": \"users\", \"filter\": {\"_id\": \"?\"}}"}),
            150_000,
        );
        let hint = analyze(&request(&[by_id]), &Thresholds::default())[0]
            .hint
            .clone()
            .unwrap_or_default();
        assert!(!hint.contains("createIndex"), "{hint}");
    }

    #[test]
    fn repeats_get_their_system_s_own_way_to_batch() {
        let hint_of = |kind: &'static str, attrs: Value| {
            let call = || op(kind, "call", attrs.clone(), 1000);
            analyze(&request(&[call(), call(), call()]), &Thresholds::default())[0]
                .hint
                .clone()
                .unwrap_or_default()
        };

        assert!(
            hint_of(
                "sqs",
                serde_json::json!({"messaging.system": "sqs", "messaging.destination.name": "jobs"})
            )
            .contains("SendMessageBatch")
        );
        assert!(hint_of("kafka", serde_json::json!({"messaging.system": "kafka", "messaging.destination.name": "orders"}))
            .contains("flush once"));
        assert!(
            hint_of(
                "dynamodb",
                serde_json::json!({"db.system": "dynamodb", "db.operation": "GetItem",
                                                       "db.collection.name": "users"})
            )
            .contains("BatchGetItem")
        );
        // A system with no way of its own: the family's.
        assert!(
            hint_of(
                "db",
                serde_json::json!({"db.system": "neo4j", "db.operation": "MATCH"})
            )
            .starts_with("Fetch the items in one query")
        );
    }

    #[test]
    fn most_common_keeps_the_first_on_a_tie() {
        assert_eq!(most_common(["b", "a", "a", "b"]), Some(("b", 2)));
    }
}
