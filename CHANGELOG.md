# Changelog

## Unreleased

### Changed

- Finding a trace's issues costs half what it did: the issues go into its
  document without parsing the whole document into a tree and writing it out
  again, which cost three times the analysis itself (Django's N+1 example:
  928 µs, now 413 µs).
- The console's lists read less. The calls lists (Database, Redis, Cache,
  HTTP and the other systems) count calls from one index, without reading the
  table: on 500 traces, 52 ms became 10 ms. The Services page, and the pages
  that group traces by an attribute (tasks, GraphQL, commands, WebSockets),
  read a trace's attributes from a column of their own rather than from its
  whole document: Services went from 65 ms to 2 ms.
- The store's format is version 19 (a trace's `attrs` column). The agent
  starts a new store file. The traces in the old one aren't carried over.
- Writing traces costs less. Each insert is prepared once rather than for
  every row, and a new trace no longer looks for rows of an earlier copy of
  itself. Rotating a full store deletes the oldest traces' rows by their ids,
  instead of reading every row of every table to find them. 200 traces into a
  store at its 2,000: 552 ms, now 210 ms.

### Added

- Share a trace as one HTML file. **Share** on a trace's page in the console,
  or its icon in the panel's bar, downloads the console itself with the trace
  and the traces linked to it inside: it opens in any browser, read-only, with
  no agent and no network, for a teammate, a pull request or a bug report. By
  default it leaves out what stays local on the way to Tracepanel Cloud: query
  parameters, email bodies, a user's name and email, log fields and the local
  variables of errors. **Include values** keeps them, with the plans of slow
  queries. The agent serves the data at `GET /api/snapshot/{id}`.
- A new issue, `large-result`: a SELECT with no LIMIT that returned
  `large_result_rows` rows or more (1000 by default), as the SDK counts what
  was fetched (`db.response.returned_rows`, OpenTelemetry's name for it, which
  the OpenTelemetry mapping keeps). The hint says how to page or stream it.
- A slow query whose LIKE pattern starts with `%` (Django's `contains` and
  `icontains`) says why no index helps, and what to do instead: match the
  start, or a trigram index or full-text search.
- Two new issues. `queue-wait`: a task that waited in its queue longer
  than `queue_wait_ms` (1 s by default) before a worker took it, a sign the
  workers are all busy. `blocking-call`: SQL, an HTTP call, Redis or a cache
  call made synchronously on an event loop's thread (the SDK marks it), which
  makes every other request on the loop wait. One issue per place in the
  code, once its calls cost 5 ms together, with what to use instead.
- The agent takes OpenTelemetry spans over OTLP/HTTP (`--otlp`, by default
  127.0.0.1:4318, where exporters send them unless told otherwise), protobuf
  or JSON, gzipped or not. A service exporting with any OpenTelemetry SDK
  shows in the console with no Tracepanel SDK: each service's work for one
  request, task or command is a trace, its spans mapped by the semantic
  conventions and analyzed as an SDK's. A port in use is said and skipped.
- A trace links to the trace in another app that its call reached, by the
  W3C trace context the call carried: `called_by` on one, `calls` on the
  other, and the call tree shows the reached app's trace under the call. The
  architecture diagram draws an arrow from app to app in place of the
  server the caller saw (its HTTP host), and an app only other apps call
  has no clients arrow. `/api/services` lists these app links.
- Tiles above a system's page sum up its calls, all of them and with the
  page's filters: how many and in how many requests, their time and p95, how
  many per request (up to the most in one), how many failed (a click shows
  them), and a cache's hit rate. `/api/calls/summary` answers them.
- The Services page draws the project's architecture from its calls: where
  work comes in, the apps' roles framed by project, the servers they call,
  and an arrow per call, laid out left to right in layers (dagre), so a
  broker sits between the app that enqueues and the worker that takes.
  Arrows are thicker for more calls and red with failures, and one opens
  its traces. A box opens where its calls are listed, and hovering it brings
  out its arrows. "Copy as Mermaid" puts the same diagram on the clipboard
  for a README or an issue. A zoom is kept across visits, and the table
  below keeps the numbers.
- The services diagram and table show one card per server (its address and
  port), however many ways the app uses it: Redis as a datastore and as a
  cache backend is one card, "Cache redis · Database 1". Its calls are the
  server's: a cache's commands to Redis count once.
- Spans an OpenTelemetry instrumentation recorded are mapped by the agent,
  from the semantic conventions (older and current attribute names alike),
  so every SDK can send them as they are (kind `otel`). SQL becomes a query
  with its fingerprint and parameters, whichever form the instrumentation
  records them in, and gets the same issues as an SDK's own. So do Redis, HTTP
  calls and gRPC. MongoDB, Elasticsearch and OpenSearch, Cassandra, DynamoDB,
  Memcached, Kafka, RabbitMQ and SQS get a span kind each. A database, broker
  or RPC system the agent doesn't know gets its family's kind (`db`,
  `messaging`, `rpc`) under its own name, so it is never lost.
- One model for every call to another system: SQL, Redis, a cache,
  datastores, brokers, RPC and HTTP. Each system the app called gets a page,
  with the same columns and filters (time, target, operation, failed), and
  issues by its family's rules: N+1 and duplicates for any datastore or RPC
  system, a publish per item for a broker. A new system needs no code.
- The MCP tool `list_calls` lists the calls to any system (`system:redis`,
  `system:sql`) with the key `call:` finds their traces by.
- A trace has a tab for each list a request is most often opened for:
  Database (SQL with its plans), Cache, HTTP calls and Logs, each when the
  request has any. The calls to other systems (Redis used directly,
  MongoDB, a broker) are in the call tree, and the console has a page for
  each. A tile per system shows its calls and time. The Mail tab is gone:
  an email is in the call tree, and the Emails page lists them all.
- The call tree's details pane can be resized: drag its edge, or focus it
  and use the arrow keys. The width is kept, and a double click restores the
  default.
- The call tree's time breakdown and its filters are one row: a share of
  the time with rows in the tree (Database, Templates, Cache…) is a filter
  chip with their count, and Logs, Errors and the other filters follow it.

### Changed

- The store's format is now version 18: one table of calls in place of the
  tables for queries, HTTP calls, Redis and cache calls. A store from an
  earlier version is left as it is, and the agent starts a new, empty one.
- System pages live at `#/calls/<system>`, and `/api/calls?system=` lists any
  system's calls. `/api/queries`, `/api/redis` and `/api/cache` are gone, and
  `/api/calls` answers for every system, not only HTTP.
- The trace search takes `call:<key>` for a call to any system, SQL included.
  `query:`, `redis_call:` and `cache_call:` are gone.
- The MCP tool `list_queries` is now `list_calls`.
- `/api/counts` lists the systems with calls (`sections.systems`) in place of
  the `calls`, `redis` and `cache` flags, and `/api/values` gives each
  system's targets and operations in place of `host`, `redis` and `cache`.

### Fixed

- The panel no longer blinks through an empty pane when a new request
  arrives: the request on screen stays until the next one is loaded.
- The search palette's Go to lists every system's page, as the sidebar does,
  and the sidebar's list scrolls when it is taller than the window.
- The divider between the call tree and its details runs the full height.
- A trace received twice (sent again with late spans) counted its queries,
  calls and services twice.

## 0.0.1a2 (2026-10-12)

### Added

- The agent is on npm too, as `@tracepanel/agent`: `npx tracepanel-agent`
  runs the same binaries as the PyPI wheels, one package per platform.
- Redis is a span kind of its own, `redis`: a datastore, not a cache. A
  cache operation (`cache`, from any cache library) is a span of its own too,
  with its Redis commands as children when its backend is Redis. Issues are
  found on the layer they are fixed on: a cache N+1 on the cache operations,
  not again on their Redis commands.
- Outgoing HTTP calls, Redis commands and cache operations get the same
  analysis as SQL. Calls a loop makes to one endpoint
  (`GET api.example.com/users/{id}`) or one key pattern (`user:{id}`) are an
  N+1. The same read made twice is a duplicate. An HTTP call slower than
  `slow_http_ms` (500 ms by default) is a new issue, `slow-http`. Repeated Redis
  commands and cache operations are an issue only when they cost
  `n_plus_one_min_ms` (5 ms by default) together, by their median call: an
  in-memory store answers in a fraction of a millisecond.
- Three data pages next to Database: Redis, Cache and HTTP calls. Each lists
  what the app called, grouped by key pattern or endpoint, with the same
  columns (calls, requests, most in one request, failures, total and slowest
  time) and the same filters (time, where to, operation, failed). Redis also
  says what sent a command (the app, a cache, a task queue), and Cache its hit
  rate. Each shows in the sidebar once the app has used it, and links to the
  requests that made the call.
- Database gets the same filters: `op:` (SELECT, INSERT…) and `failed:`.
- In a trace: an HTTP calls tab, tiles with the Redis commands and HTTP calls,
  lanes on the timeline, "Redis" and "External calls" in the time breakdown (a
  cache's Redis commands count as Cache), and similar calls folded into one
  row of the call tree, like queries.

### Changed

- The store's format is now version 16. A store from an earlier version is
  left as it is, and the agent starts a new, empty one.

## 0.0.1a1 (2026-10-12)

The first release of the Tracepanel agent. It is an alpha: the store format
and the protocol can still change between versions.

### Added

- The agent receives the traces and logs of a project's processes over a
  local socket, or over TCP with `--listen tcp:HOST:PORT` (the default on
  Windows). There is one agent per project. The first trace starts it, and it
  exits after 30 minutes unused.
- It finds N+1 queries, duplicate and slow SQL, long transactions, work done
  inside a transaction, htmx mistakes and errors. Each issue names the line of
  code it comes from and the fix for the ORM in use.
- It keeps the newest traces in `.tracepanel/` in the project, and serves the
  panel, the console and their API on `127.0.0.1`. Several apps can share one
  store, and the console shows one app or all of them.
- The panel on your pages: a badge with the request's status, time, queries
  and issues, and a hover card. A click opens the panel, docked at the bottom
  or on the right. It lists every request the page made, `fetch()` calls
  included, each with its call tree, SQL, issues and logs. The call tree's
  details open beside a wide tree and under the row in a narrow one.
- The console at `/__tracepanel__/`: HTTP endpoints, GraphQL operations,
  background tasks, commands and WebSockets, the services an app calls, SQL,
  logs, emails, errors and issues, with charts over time. One search covers all
  of them, with filters such as `route:`, `status:`, `level>=warning` or
  `extra.order_id:42`.
- Logs, each line linked to the request, job or command that wrote it.
- `tracepanel-agent mcp` gives AI coding agents the traces over MCP: recent
  traces, one trace in a few lines, the next trace that matches, and a
  comparison of two traces. SQL parameters and local variables stay out unless
  you pass `--values`.
- Wheels for Linux (x86_64, arm64, armv7, armv6, i686, ppc64le, s390x,
  riscv64, glibc and musl), macOS (Apple silicon and Intel) and Windows
  (x86_64, x86, arm64), and an sdist for other platforms.
- The license is the Functional Source License (FSL-1.1-ALv2). This version
  becomes Apache License 2.0 two years after its release.
