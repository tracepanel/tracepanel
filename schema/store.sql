-- tracepanel's local store: one SQLite file per format version, written by the project's tracepanel-agent alone. The
-- trace's doc is what was received; every other table is derived from it (crates/store-local/src/write.rs).
-- version: 20
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS traces (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    start INTEGER NOT NULL,
    duration INTEGER NOT NULL,
    status TEXT NOT NULL,
    http_status INTEGER,
    method TEXT,
    path TEXT,
    route TEXT,
    view TEXT,
    user_id TEXT,
    queries INTEGER NOT NULL,
    db_time INTEGER NOT NULL,
    issues INTEGER NOT NULL,
    issue_kinds TEXT NOT NULL,
    errors INTEGER NOT NULL,
    logs INTEGER NOT NULL,
    mails INTEGER NOT NULL,
    db_aliases TEXT NOT NULL,
    cache_aliases TEXT NOT NULL,
    task_state TEXT,
    htmx TEXT,
    -- service.name: one store can hold several apps (services sending to one agent).
    service TEXT NOT NULL,
    -- The trace's attrs (its doc's "attrs"), what a page groups or filters by (json_extract(attrs, ...)): reading them
    -- from the doc parsed the whole trace, spans and logs included, for every row.
    attrs TEXT NOT NULL,
    doc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS traces_start ON traces (start DESC);
CREATE INDEX IF NOT EXISTS traces_route ON traces (route);
CREATE INDEX IF NOT EXISTS traces_service ON traces (service);
CREATE TABLE IF NOT EXISTS issues (
    fingerprint TEXT PRIMARY KEY,
    fingerprint_version INTEGER NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    culprit TEXT,
    hint TEXT,
    occurrences INTEGER NOT NULL,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    last_trace_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS issue_traces (
    fingerprint TEXT NOT NULL,
    trace_id TEXT NOT NULL,
    PRIMARY KEY (fingerprint, trace_id)
);
-- Every table with rows per trace has an index on trace_id: rotation and a trace sent again delete by it.
CREATE INDEX IF NOT EXISTS issue_traces_trace ON issue_traces (trace_id);
CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY,
    trace_id TEXT NOT NULL,
    time INTEGER NOT NULL,
    level TEXT NOT NULL,
    level_no INTEGER NOT NULL,
    logger TEXT NOT NULL,
    message TEXT NOT NULL,
    exception TEXT,
    attrs TEXT NOT NULL,
    -- The span it was logged in, and the spans around it up to the trace's own (left out: the trace is its source
    -- already), innermost first, as [{kind, system, name}]: a Kafka publish in a view. `in:` and `span:` search them.
    span_id TEXT,
    spans TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS logs_time ON logs (time DESC);
CREATE INDEX IF NOT EXISTS logs_trace ON logs (trace_id);
-- Operations: every call the app makes to another system (crates/analysis/src/calls.rs), one row per span. `system` is
-- what the console lists them under (sql, redis, cache, http, mongodb, kafka, grpc, or a system's own name for the
-- generic db / messaging / rpc kinds), `family` the rules its issues follow, `key` the id a list groups by and a trace
-- search links with (`op:<key>`; for SQL the statement's fingerprint key, `query:<key>`). `target` is where it went (a
-- database alias, an instance, a host, a topic), `op` the verb, `template` what its repeats share (a fingerprint, a key
-- or path with its ids as {id}, a collection). `vendor` is SQL's database or a cache's backend, `params_hash` SQL's
-- parameters, `via` why a Redis command ran (direct, cache, task), `hit` a cache get's outcome.
CREATE TABLE IF NOT EXISTS calls (
    trace_id TEXT NOT NULL,
    span_id TEXT NOT NULL,
    key TEXT NOT NULL,
    system TEXT NOT NULL,
    family TEXT NOT NULL,
    target TEXT NOT NULL,
    op TEXT NOT NULL,
    template TEXT NOT NULL,
    name TEXT NOT NULL,
    statement TEXT,
    vendor TEXT,
    params_hash TEXT,
    via TEXT,
    hit INTEGER,
    error INTEGER NOT NULL,
    start INTEGER NOT NULL,
    duration INTEGER NOT NULL,
    origin TEXT
);
-- A list of calls groups them by key and counts them per trace, filtered by system, family, target or time: from this
-- index alone, without reading the table. The latest call and the most common line of code come from it too.
CREATE INDEX IF NOT EXISTS calls_group ON calls (
    key, trace_id, error, duration, start, hit, system, family, target, origin
);
CREATE INDEX IF NOT EXISTS calls_trace ON calls (trace_id);
CREATE INDEX IF NOT EXISTS calls_system ON calls (system);
CREATE TABLE IF NOT EXISTS mails (
    trace_id TEXT NOT NULL,
    span_id TEXT NOT NULL,
    time INTEGER NOT NULL,
    subject TEXT NOT NULL,
    sender TEXT,
    recipients TEXT NOT NULL,
    sent INTEGER,
    html INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mails_time ON mails (time DESC);
CREATE INDEX IF NOT EXISTS mails_trace ON mails (trace_id);
CREATE TABLE IF NOT EXISTS links (
    trace_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    linked_trace TEXT NOT NULL,
    linked_span TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS links_linked ON links (linked_trace);
CREATE INDEX IF NOT EXISTS links_trace ON links (trace_id);
-- The W3C ids a trace carries (`w3c.*` attributes): the call into it ('in': the caller's span id) and its calls that
-- carry the trace on to another service ('out': its span, `span_id`, and the server it reached, `peer`). A trace
-- whose 'out' span is another's 'in', in the same W3C trace, is the one that called it: `links` gets `called_by`.
CREATE TABLE IF NOT EXISTS w3c (
    trace_id TEXT NOT NULL,
    w3c_trace TEXT NOT NULL,
    w3c_span TEXT NOT NULL,
    side TEXT NOT NULL,
    span_id TEXT,
    peer TEXT
);
CREATE INDEX IF NOT EXISTS w3c_span ON w3c (w3c_trace, w3c_span);
CREATE INDEX IF NOT EXISTS w3c_trace ON w3c (trace_id);
CREATE TABLE IF NOT EXISTS peers (
    trace_id TEXT NOT NULL,
    start INTEGER NOT NULL,
    service TEXT NOT NULL,
    role TEXT NOT NULL,
    peer TEXT NOT NULL,
    kind TEXT NOT NULL,
    system TEXT NOT NULL,
    address TEXT,
    port INTEGER,
    namespace TEXT,
    alias TEXT,
    direction TEXT NOT NULL,
    calls INTEGER NOT NULL,
    duration INTEGER NOT NULL,
    errors INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS peers_trace ON peers (trace_id);
CREATE INDEX IF NOT EXISTS peers_start ON peers (start DESC);
-- Task runs whose queue carries no headers (Django Tasks) are linked to their enqueue by task id.
CREATE TABLE IF NOT EXISTS task_enqueues (task_id TEXT NOT NULL, trace_id TEXT NOT NULL, span_id TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS task_enqueues_task ON task_enqueues (task_id);
CREATE INDEX IF NOT EXISTS task_enqueues_trace ON task_enqueues (trace_id);
CREATE TABLE IF NOT EXISTS task_runs (task_id TEXT NOT NULL, trace_id TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS task_runs_task ON task_runs (task_id);
CREATE INDEX IF NOT EXISTS task_runs_trace ON task_runs (trace_id);
