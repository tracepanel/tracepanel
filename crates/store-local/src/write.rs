//! Writing the store: a trace's rows (the trace, its operations, logs, emails, issues, links, peers), and
//! pruning to `max_traces`.

use super::*;

/// The store's tables (`schema/store.sql`); its `-- version:` line names the file, a new format a new file.
pub const SCHEMA: &str = include_str!("../../../schema/store.sql");
pub(crate) const FTS_SCHEMA: &str =
    "CREATE VIRTUAL TABLE IF NOT EXISTS logs_fts USING fts5(message, logger)";
pub(crate) const TABLES: [&str; 13] = [
    "meta",
    "traces",
    "issues",
    "issue_traces",
    "logs",
    "logs_fts",
    "calls",
    "mails",
    "links",
    "peers",
    "task_enqueues",
    "task_runs",
    "w3c",
];
pub(crate) const LEVELS: [(&str, i64); 5] = [
    ("debug", 10),
    ("info", 20),
    ("warning", 30),
    ("error", 40),
    ("critical", 50),
];
pub const DEFAULT_MAX_TRACES: i64 = 2000;

/// The format version in the schema's header (`-- version: 13`): a new format is a new file.
pub fn version() -> &'static str {
    SCHEMA
        .lines()
        .find_map(|line| line.strip_prefix("-- version: "))
        .expect("schema/store.sql has no '-- version: N' line")
}

/// The store's file in the store directory: one per format version.
pub fn path_in(dir: &Path) -> PathBuf {
    dir.join(format!("traces.v{}.sqlite3", version()))
}

pub struct Store {
    db: Connection,
    fts: bool,
    pub max_traces: i64,
    written_since_prune: i64,
}

impl Store {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)
                .map_err(|error| rusqlite::Error::ToSqlConversionFailure(error.into()))?;
        }
        let db = Connection::open(path)?;
        db.busy_timeout(std::time::Duration::from_secs(5))?;
        // Every insert a trace makes, prepared once (rusqlite keeps 16 by default, fewer than writing uses).
        db.set_prepared_statement_cache_capacity(64);
        db.pragma_update(None, "journal_mode", "WAL")?;
        db.pragma_update(None, "synchronous", "NORMAL")?;
        let has_meta: bool = db.query_row(
            "SELECT count(*) FROM sqlite_master WHERE name = 'meta'",
            [],
            |row| row.get(0),
        )?;
        let stored: Option<String> = if has_meta {
            db.query_row("SELECT value FROM meta WHERE key = 'version'", [], |row| {
                row.get(0)
            })
            .ok()
        } else {
            None
        };
        if stored.as_deref() != Some(version()) {
            // Local data is disposable: recreate on a format change.
            for table in TABLES {
                db.execute_batch(&format!("DROP TABLE IF EXISTS {table}"))?;
            }
        }
        db.execute_batch(SCHEMA)?;
        // SQLite built without FTS5: log search falls back to LIKE (the bundled one has it).
        let fts = db.execute_batch(FTS_SCHEMA).is_ok();
        db.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES ('version', ?1)",
            [version()],
        )?;
        Ok(Self {
            db,
            fts,
            max_traces: DEFAULT_MAX_TRACES,
            written_since_prune: 0,
        })
    }

    pub fn write(&mut self, traces: &[Received]) -> rusqlite::Result<()> {
        let tx = self.db.transaction()?;
        for received in traces {
            write_trace(&tx, self.fts, &received.trace, &received.doc)?;
        }
        self.written_since_prune += traces.len() as i64;
        // Rotation scans every table: once the store is 10% over its limit, not on every write.
        if self.written_since_prune >= (self.max_traces / 10).max(1) {
            prune(&tx, self.fts, self.max_traces)?;
            self.written_since_prune = 0;
        }
        tx.commit()
    }
}

pub(crate) fn prune(db: &Connection, fts: bool, max_traces: i64) -> rusqlite::Result<()> {
    // The oldest traces past the limit, then their rows, by the trace_id indexes. Finding the rows of traces no longer
    // there (trace_id NOT IN traces) read every row of every table: 390 ms in a store of 2,000, every 200 traces.
    db.execute_batch(
        "CREATE TEMP TABLE IF NOT EXISTS pruned (id TEXT PRIMARY KEY); DELETE FROM pruned;",
    )?;
    let pruned = db.execute(
        "INSERT INTO pruned SELECT id FROM traces ORDER BY start DESC LIMIT -1 OFFSET ?1",
        [max_traces],
    )?;
    if pruned == 0 {
        return Ok(());
    }
    db.execute("DELETE FROM traces WHERE id IN (SELECT id FROM pruned)", [])?;
    delete_rows(db, fts, "trace_id IN (SELECT id FROM pruned)", [])
}

/// The tables with rows per trace: a trace's statements, calls, logs, issues, peers and links.
const PER_TRACE: [&str; 9] = [
    "logs",
    "calls",
    "issue_traces",
    "mails",
    "links",
    "peers",
    "task_enqueues",
    "task_runs",
    "w3c",
];

fn delete_rows<P: rusqlite::Params + Clone>(
    db: &Connection,
    fts: bool,
    which: &str,
    params: P,
) -> rusqlite::Result<()> {
    if fts {
        db.execute(
            &format!("DELETE FROM logs_fts WHERE rowid IN (SELECT id FROM logs WHERE {which})"),
            params.clone(),
        )?;
    }
    for table in PER_TRACE {
        db.execute(
            &format!("DELETE FROM {table} WHERE {which}"),
            params.clone(),
        )?;
    }
    Ok(())
}

/// A trace received again (an SDK that sends it once more, with spans that came late): what the first copy wrote
/// goes, so its statements, calls and issues count once.
fn forget(db: &Connection, fts: bool, trace_id: &str) -> rusqlite::Result<()> {
    db.execute(
        "UPDATE issues SET occurrences = occurrences - 1
         WHERE fingerprint IN (SELECT fingerprint FROM issue_traces WHERE trace_id = ?1)",
        [trace_id],
    )?;
    delete_rows(db, fts, "trace_id = ?1", [trace_id])
}

pub(crate) fn write_trace(
    db: &Connection,
    fts: bool,
    trace: &Trace,
    doc: &str,
) -> rusqlite::Result<()> {
    // A trace sent again replaces its first copy; a new one (nearly every trace) has nothing to forget, and looking
    // for its rows in tables without an index on trace_id read them whole, slower the fuller the store.
    let known: bool = db
        .prepare_cached("SELECT EXISTS (SELECT 1 FROM traces WHERE id = ?1)")?
        .query_row([&trace.id], |row| row.get(0))?;
    if known {
        forget(db, fts, &trace.id)?;
    }
    let attrs = &trace.attrs;
    let sql_spans: Vec<&Span> = trace
        .spans
        .iter()
        .filter(|span| span.kind == "sql")
        .collect();
    let kinds: BTreeSet<String> = trace
        .issues
        .iter()
        .map(|issue| issue.kind.clone())
        .collect();
    let db_aliases: BTreeSet<String> = sql_spans
        .iter()
        .map(|span| or_default(&span.attrs, "db.alias", "default"))
        .collect();
    let cache_aliases: BTreeSet<String> = trace
        .spans
        .iter()
        .filter(|span| span.kind == "cache")
        .map(|span| or_default(&span.attrs, "cache.alias", "default"))
        .collect();
    let task_state = if truthy(attrs.get("task.state")) {
        Sql::Text(py_str(&attrs["task.state"]).to_lowercase())
    } else {
        Sql::Null
    };
    let htmx = if truthy(attrs.get("htmx.request")) {
        Sql::Text(
            if truthy(attrs.get("htmx.boosted")) {
                "boosted"
            } else {
                "request"
            }
            .into(),
        )
    } else {
        Sql::Null
    };
    db.prepare_cached(
        "INSERT OR REPLACE INTO traces (id, kind, name, start, duration, status, http_status, method, path, route, view,
         user_id, queries, db_time, issues, issue_kinds, errors, logs, mails, db_aliases, cache_aliases, task_state,
         htmx, service, attrs, doc) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17,
         ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26)",
    )?
    .execute(
        params![
            trace.id,
            trace.kind,
            trace.name,
            trace.start,
            trace.duration,
            trace.status,
            sql(attrs.get("http.status_code")),
            sql(attrs.get("http.method")),
            sql(attrs.get("http.path")),
            sql(attrs.get("http.route")),
            sql(attrs.get("code.view")),
            sql(attrs.get("user.id")),
            sql_spans.len() as i64,
            sql_spans.iter().map(|span| span.duration).sum::<i64>(),
            // Findings only: an error is counted in `errors` (and kept with the issues for grouping).
            trace.issues.iter().filter(|issue| issue.kind != "error").count() as i64,
            alias_list(&kinds),
            trace.errors.len() as i64,
            trace.logs.len() as i64,
            trace.spans.iter().filter(|span| span.kind == "mail").count() as i64,
            alias_list(&db_aliases),
            alias_list(&cache_aliases),
            task_state,
            htmx,
            or_default(attrs, "service.name", ""),
            serde_json::to_string(attrs).unwrap_or_else(|_| "{}".to_owned()),
            doc,
        ],
    )?;
    for log in &trace.logs {
        let level = LEVELS
            .iter()
            .find(|(name, _)| *name == log.level)
            .map_or(0, |(_, number)| *number);
        db.prepare_cached(
            "INSERT INTO logs (trace_id, time, level, level_no, logger, message, exception, attrs)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        )?
        .execute(params![
            trace.id,
            log.time,
            log.level,
            level,
            log.logger,
            log.message,
            log.exception,
            Value::Object(log.attrs.clone()).to_string()
        ])?;
        if fts {
            db.prepare_cached("INSERT INTO logs_fts (rowid, message, logger) VALUES (?1, ?2, ?3)")?
                .execute(params![db.last_insert_rowid(), log.message, log.logger])?;
        }
    }
    for span in &trace.spans {
        let Some(operation) = tracepanel_analysis::calls::operation(trace, span) else {
            continue;
        };
        db.prepare_cached(
            "INSERT INTO calls (trace_id, span_id, key, system, family, target, op, template, name, statement, vendor,
             params_hash, via, hit, error, start, duration, origin)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
        )?
        .execute(
            params![
                trace.id,
                span.id,
                call_key(&operation),
                operation.system,
                operation.family,
                operation.target,
                operation.op,
                operation.template,
                operation.name,
                operation.statement,
                operation.vendor,
                operation.params_hash,
                operation.via,
                operation.hit,
                span.status == "error",
                span.start,
                span.duration,
                sql(span.attrs.get("code.origin")),
            ],
        )?;
    }
    let service = or_default(attrs, "service.name", "");
    let role = or_default(attrs, "service.role", &trace.kind);
    for ((peer, direction), usage) in dependencies(trace) {
        db.prepare_cached(
            "INSERT INTO peers (trace_id, start, service, role, peer, kind, system, address, port, namespace, alias,
             direction, calls, duration, errors) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
        )?
        .execute(
            params![
                trace.id,
                trace.start,
                service,
                role,
                peer.id(),
                peer.kind,
                peer.system,
                peer.address,
                peer.port,
                peer.namespace,
                peer.alias,
                direction,
                usage.calls,
                usage.duration,
                usage.errors,
            ],
        )?;
    }
    for link in &trace.links {
        db.prepare_cached(
            "INSERT INTO links (trace_id, kind, linked_trace, linked_span) VALUES (?1, ?2, ?3, ?4)",
        )?
        .execute(params![trace.id, link.kind, link.trace_id, link.span_id])?;
    }
    link_tasks(db, trace)?;
    link_calls(db, trace)?;
    for span in trace.spans.iter().filter(|span| span.kind == "mail") {
        let recipients: BTreeSet<String> = ["mail.to", "mail.cc"]
            .iter()
            .filter_map(|key| span.attrs.get(*key).and_then(Value::as_array))
            .flatten()
            .map(py_str)
            .collect();
        db.prepare_cached(
            "INSERT INTO mails (trace_id, span_id, time, subject, sender, recipients, sent, html)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        )?
        .execute(params![
            trace.id,
            span.id,
            span.start,
            or_default(&span.attrs, "mail.subject", ""),
            sql(span.attrs.get("mail.from")),
            alias_list(&recipients),
            sql(span.attrs.get("mail.sent")),
            // attrs.get("mail.html") is not None
            !matches!(span.attrs.get("mail.html"), None | Some(Value::Null)),
        ])?;
    }
    for issue in &trace.issues {
        db.prepare_cached(
            "INSERT INTO issues (fingerprint, fingerprint_version, kind, title, culprit, hint,
                                 occurrences, first_seen, last_seen, last_trace_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8, ?9)
             ON CONFLICT (fingerprint) DO UPDATE SET
                 title = excluded.title, culprit = excluded.culprit, hint = excluded.hint,
                 occurrences = occurrences + 1, last_seen = excluded.last_seen,
                 last_trace_id = excluded.last_trace_id",
        )?
        .execute(params![
            issue.fingerprint,
            issue.fingerprint_version,
            issue.kind,
            issue.title,
            issue.culprit,
            issue.hint,
            trace.start,
            trace.start,
            trace.id
        ])?;
        db.prepare_cached(
            "INSERT OR IGNORE INTO issue_traces (fingerprint, trace_id) VALUES (?1, ?2)",
        )?
        .execute(params![issue.fingerprint, trace.id])?;
    }
    Ok(())
}

/// Link a service's trace to the trace that called it, by the W3C ids both carry, whichever is written first: the
/// caller's span that carried the trace on is the callee's parent.
pub(crate) fn link_calls(db: &Connection, trace: &Trace) -> rusqlite::Result<()> {
    let Some(w3c_trace) = text(trace.attrs.get("w3c.trace_id")) else {
        return Ok(());
    };
    if let Some(parent) = text(trace.attrs.get("w3c.parent_span_id")) {
        db.prepare_cached(
            "INSERT INTO w3c (trace_id, w3c_trace, w3c_span, side) VALUES (?1, ?2, ?3, 'in')",
        )?
        .execute(params![trace.id, w3c_trace, parent])?;
    }
    for span in &trace.spans {
        let Some(w3c_span) = text(span.attrs.get("w3c.span_id")) else {
            continue;
        };
        db.prepare_cached(
            "INSERT INTO w3c (trace_id, w3c_trace, w3c_span, side, span_id, peer) VALUES (?1, ?2, ?3, 'out', ?4, ?5)",
        )?
        .execute(
            params![trace.id, w3c_trace, w3c_span, span.id, services::peer(span).map(|peer| peer.id())],
        )?;
    }
    db.prepare_cached(
        "INSERT INTO links (trace_id, kind, linked_trace, linked_span)
         SELECT callee.trace_id, 'called_by', caller.trace_id, caller.span_id
         FROM w3c callee JOIN w3c caller ON caller.w3c_trace = callee.w3c_trace AND caller.w3c_span = callee.w3c_span
         WHERE callee.side = 'in' AND caller.side = 'out' AND (callee.trace_id = ?1 OR caller.trace_id = ?1)
           AND NOT EXISTS (SELECT 1 FROM links WHERE trace_id = callee.trace_id AND kind = 'called_by')",
    )?
    .execute(
        params![trace.id],
    )?;
    Ok(())
}

/// Link task runs to their enqueue span by task id, whichever of the two traces is written first.
pub(crate) fn link_tasks(db: &Connection, trace: &Trace) -> rusqlite::Result<()> {
    for span in trace
        .spans
        .iter()
        .filter(|span| span.kind == "task.enqueue" && truthy(span.attrs.get("task.id")))
    {
        db.prepare_cached(
            "INSERT INTO task_enqueues (task_id, trace_id, span_id) VALUES (?1, ?2, ?3)",
        )?
        .execute(params![py_str(&span.attrs["task.id"]), trace.id, span.id])?;
    }
    let enqueued_by = trace.links.iter().any(|link| link.kind == "enqueued_by");
    if trace.kind == "task" && truthy(trace.attrs.get("task.id")) && !enqueued_by {
        db.prepare_cached("INSERT INTO task_runs (task_id, trace_id) VALUES (?1, ?2)")?
            .execute(params![py_str(&trace.attrs["task.id"]), trace.id])?;
    }
    db.prepare_cached(
        "INSERT INTO links (trace_id, kind, linked_trace, linked_span)
         SELECT run.trace_id, 'enqueued_by', enqueue.trace_id, enqueue.span_id
         FROM task_runs run JOIN task_enqueues enqueue ON enqueue.task_id = run.task_id
         WHERE (run.trace_id = ?1 OR enqueue.trace_id = ?1)
           AND NOT EXISTS (SELECT 1 FROM links WHERE trace_id = run.trace_id AND kind = 'enqueued_by')",
    )?
    .execute(
        params![trace.id],
    )?;
    Ok(())
}
