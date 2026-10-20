# Schemas

The contracts between the SDKs, the agent and the UI.

| File | Contents |
| --- | --- |
| `trace.schema.json` | A trace as an SDK records and sends it, and as the API returns it with the issues the agent found |
| `openapi.yaml` | The console's API. The UI generates its types from it (`pnpm api`) |
| `search.json` | The fields of the search language, which `GET /api/search` serves |
| `store.sql` | The store's tables. Its `-- version:` line names the store's file |
| `examples/` | Traces as the SDKs send them, with the issues each must get (`expected.json`). `crates/server/tests/examples.rs` checks the schema, the analysis and the API against them |

Times are Unix epoch microseconds (UTC), durations are microseconds, and ids
are ULIDs.

## Entities

- **Trace**: an HTTP request, a background task or a management command
  (`kind`). A task is a trace of its own, with a `link` to the span that
  enqueued it.
- **Span**: a unit of work inside a trace. `kind` is one of `http`, `sql`,
  `cache`, `http.client`, `template`, `task.enqueue`, `task.run`, `command` and
  `function`. `attrs` are open and namespaced: `http.route`, `db.fingerprint`,
  `cache.hit`, `code.origin`.
- **Log**: a log record, bound to a span.
- **Error**: an exception with its frames, bound to a span.
- **Issue**: a problem the agent finds (`n+1`, `duplicates`, `slow-sql`,
  `error` and others), with a stable `fingerprint`. SDKs send traces without
  issues.
- **Task event**: a step of a task in flight (`enqueued`, `started`,
  `retried`, `finished`, and a worker's `heartbeat`), sent before the task's
  trace exists. The agent keeps the tasks in flight in memory, not in the
  store, and serves them at `GET /api/tasks/live`. `crates/protocol/src/live.rs`
  names the fields.

## Add an example

Run an app against `tracepanel-agent --record DIR`. The agent saves every trace
as it arrives, before the analysis. Copy the traces worth keeping here, with a
name that says what each shows, add them to `expected.json`, and replace the
recording machine's home directory in their paths.
