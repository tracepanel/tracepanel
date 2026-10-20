# Changelog

## Unreleased

### Added

- The agent is on Maven Central, as `dev.tracepanel:tracepanel-agent`: the
  binary of each platform, with the platform as its classifier
  (`darwin-arm64`, `linux-x64-gnu`, …). The same binaries as on PyPI and npm,
  for the Java SDK, which reaches Maven Central or a company's mirror of it.
- Releases carry signed build provenance: the wheels and the sdist, the npm
  packages, and the agent's binary for each platform. `gh attestation verify
  FILE --repo tracepanel/tracepanel` checks one. The files on PyPI carry PEP
  740 attestations too.
- The Request tab shows what a request carried, as an SDK records it: its
  query, headers, body (JSON indented), cookies and session, and the
  response's headers. They stay on this machine: the cloud and a snapshot
  without values get none of them.

## 0.3.7 (2026-10-19)

### Added

- Each trace in a list (`GET /api/traces`) carries its `service`.

### Changed

- With the page recording on, the panel's Follow new opens the view or the
  action a new request belongs to, once the agent has it, and stays there
  while that group's requests arrive. It used to jump to each request.
- When the requests in a tab come from more than one app, each request's row
  in the panel names its app, as the call tree does. A Next.js page and the
  API it calls can both answer `GET /projects`, and the two rows looked
  alike.

## 0.3.6 (2026-10-19)

### Changed

- In the call tree, a click on a row's chevron opens or closes the rows
  under it and nothing else. It used to select the row and open its
  details too. On a focused row the arrow keys do the same.
- The chip naming the app that served a call has the size and shape of the
  row's other chips.

### Fixed

- In the panel, the calls a page view or an action made are listed under
  it, with a tree's corner, also in the narrow list and also when the page
  records itself after the badge loaded. They were listed flat, apart from
  what made them.

## 0.3.5 (2026-10-19)

### Added

- The call tree opens the trace another app served for a call under that
  call: the app's view, queries, calls and issues. A chip names the app and
  its runtime. This works when the apps share an agent and when each project
  runs its own. A call used to show the other app's trace as one row.
- A query plan is in colour, as the statement above it. The operation stands
  out, a full scan's in the warning colour. Tables and indexes read as names,
  and the costs recede.

### Changed

- The panel's list of requests marks a request's issues with one chip and
  their count, so the path keeps its room. The chip's title names them.
- Explain and Explain analyze follow the query plan's heading. On a wide
  statement they were scrolled out of view at the far end.
- The console and the panel are 5% smaller.

### Fixed

- EXPLAIN runs a query that has no parameters, such as one with its values
  written in the SQL. It answered that the parameters were not recorded.
- In the call tree, a row with a long database alias and an issue keeps its
  call's text in view. The alias, the chip and the text ran into each other
  and into the bar.
- On the Services page, an app's calls to itself are a loop on its box. They
  were drawn as a stray line under it.

## 0.3.4 (2026-10-18)

### Fixed

- A Spring Boot app is named Spring Boot in the widget and the console, as
  the Java SDK labels it. It read "Spring", the first word of the name. A
  Spring MVC app seen through OpenTelemetry is still named Spring.

## 0.3.3 (2026-10-17)

### Fixed

- "Show N queries" on an issue scrolls to the group it opens. A group last in
  a long list used to open below the fold.
- The widget's pill shows a request's time as the console does. It read the
  time the app wrote before sending the response, so near half a millisecond
  the two could differ by one: 650 ms in the pill, 649 ms in the console.

## 0.3.2 (2026-10-17)

### Fixed

- An HTTP call that two layers of instrumentation both record, such as
  Next.js's fetch and undici under it, counts as one call. It is no longer
  reported as a duplicate of itself.

## 0.3.1 (2026-10-16)

A lighter console, and highlighted source in more languages.

### Added

- The source around an error's frame is highlighted in JavaScript,
  TypeScript, Java and Kotlin too, as in Python and Go.

### Changed

- The console's script is a fifth smaller (913 KB from 1,172 KB): SQL is
  formatted with the dialects of PostgreSQL, MySQL and SQLite only, and the
  source around a frame is highlighted by a tokenizer of the console's own,
  in place of Prism's grammars.

## 0.3.0 (2026-10-15)

Logs in their context: each record knows the spans it was written in, and
the search finds it by them. EXPLAIN in the agent's own console, run by the
app that recorded the query, and calls to another project's app followed to
its trace. Limits on one trace, and a store that keeps its issues whole.

The store's format changes: a project's local store starts empty after the
upgrade.

### Added

- `span_id:` finds the records logged in a span, and a record's details on
  the Logs page show its span, a filter away.
- A call an app of another project on this machine served shows under it in
  the call tree, opening in that project's console. Agents with a console
  say where they are in the user's cache (with a token only they and this
  user can read), and ask each other which of their traces served a call,
  by the W3C ids the call carried.
- EXPLAIN in the agent's own console: an app that says it can (in its
  hello) runs a recorded query's EXPLAIN on its database when the agent asks
  it, down the connection it sends its traces on. The agent writes the
  statement and reads the plan from the rows, for every SDK alike, and the
  console offers Explain once such an app is connected.
- `span:` finds traces by any of their spans' names, a view, a template or
  the app's own block, with `*` wildcards. Its hints name the spans that
  aren't calls (those have `call:`, `db:` and the rest).
- The agent stores a trace with at most 2,000 spans and 1,000 log records,
  whatever sent it: an SDK without limits of its own or OpenTelemetry. Its
  earliest spans are kept, each with its parent, and its first records. The
  Request tab says how many went (`tracepanel.dropped_spans`, `_logs`).
- A stored trace says when the agent received it (`received`): the Request
  tab says when the app's clock is off this machine's.
- A group's page picks its period, from the same presets and range as a
  list's Time, or by dragging over its calls chart.
- Tasks' System menu offers what ran this project's tasks (Celery, RQ,
  Spring's @Async, a RabbitMQ or Kafka listener), not Python's list.
- Logs: a record a task or a job wrote is found by its name, with the Task
  and Job filters or `task:` and `job:`, and `kind:` finds the records of
  each kind of trace. A task's record says it was a task's, with a button
  for every run of it, and opens the task.
- A search chip can be changed: click it, and it goes back into the box as
  text, Enter makes it a chip again.
- Logs know where in the work they were logged: each record keeps the span
  it was written in and the spans around it. `in:kafka`, `in:sql` or
  `in:view` finds the records logged inside such a call, `span:` inside a
  span by its name, and a record's details show the chain, each step a
  click away. `template:` finds every record written from the same message.
- A call's details in the call tree start with its fields in its system's
  words: a Kafka publish's topic, partition and offset, a RabbitMQ queue or
  exchange and routing key, a Redis command's key, a gRPC call's service and
  method. Every attribute follows, as recorded.
- A request's Request tab lists its own fields first and the traces linked
  to it after them, alike ones as one row: 36 deliveries to one listener are
  `×36`, with how many failed.

### Fixed

- A record's attributes came in another order on the Logs page than in its
  trace (the store keeps them sorted by name). Both list them the same way:
  where it was logged first, then its thread and template, its extra fields
  last.
- A record shows where it was logged, its code, thread, template and extra
  fields: picked in the call tree, or opened by a click on it in a trace's
  Logs tab, which shows it as the call tree does.
- A trace's Logs tab overlapped a record's time and level once the time was
  a clock. The line between the call tree and its pane runs down the whole
  view, however few the rows.
- A span whose parent never reached the agent (cut by a limit, lost on the
  way) was missing from the call tree: it shows under the request.
- An issue whose requests rotation removed pointed at a latest trace that
  was gone, and its page showed it as not found. An issue still counts
  every time it happened (its occurrences and first seen stay), its latest
  trace is the newest still stored, and with none left its page says they
  were rotated out. Links to the traces removed go with them.
- A group with one call, or calls a moment apart, gets a time axis of 10
  minutes, not one moment repeated.
- The services map shows whole, its lines' bends included: it scrolls only
  sideways, and a line routed around the boxes is inside the diagram.
- Stat tiles that don't fit one row split into two even ones, never one
  tile alone on the second.
- Enter in the search box took the first suggestion, not what was typed:
  `logger:org` became the first of the loggers starting with org. Enter
  takes what was typed, a suggestion only when the arrows picked one, and
  Tab the first. Typing the start of several values suggests all of them
  first, with a wildcard (`logger:org*`).
- A filter's menu found nothing when its key was typed in its box too
  (`logger:org` in the Logger menu).
- Typing a filter into the search box with pauses (`logger:o`) could empty
  it: the page took a search that matched nothing for an empty store and
  replaced the box. A filter still being typed stays out of the search.
- The logs' Route menu offers the routes whose requests logged anything,
  not every route. A filter's menu has one Clear.
- Emails is listed only once the app has sent one: only some frameworks
  send them through what an SDK records.
- The console asks what the backend behind it can do (`api/capabilities`):
  Explain shows only where EXPLAIN runs (the app serving the console, or a
  connected app that runs it for the agent), the user switcher only where
  the app can switch users (Django). Nothing asks for what can't answer.
- A stack's frames with no source are one line each, with nothing to open.
- A trace's Logs tab shows when each record was logged (14:03:21.146), the
  time since the request started on hover. The logs and emails lists name
  their last column Source and Sent from: a task's or a job's, not only a
  request's.

## 0.2.0 (2026-10-14)

Pages: what users do in a browser, each view and action over the requests it
made, in the console and in the panel. Apps in many more languages and
frameworks, the JVM's first.

### Added

- A Pages section in the console: each page a browser viewed, then what users
  did on it. A view is the page's load or an SPA's route change. An action is a
  click or a submit that called the API (`click "Save"`), or background calls
  nobody started. Each row has its count, failures, time and the calls it made
  to the API, opens its own page, and `page:` searches them. A trace of kind
  `page` comes from the browser: tracepanel-js records a page's views and
  actions with their `fetch()` calls, errors and console, and sends them to the
  console's address, `POST /api/ingest`, as an SDK sends its traces. A dev
  server (Vite's plugin) serves that address on the page's origin. The console
  takes JSON only, so a page on another site can't send to it.

- The panel lists what the user did in the browser when tracepanel-js
  records the page: each view and action (`click "Save"`) is a row, its
  requests under it, and opens with its calls, errors and console. Before
  the page's first request, the pill shows its view and load time, as it
  shows a server page's own load, and the runtime's mark it learned in the
  tab.

- A browser app in Services: its row opens Pages, the map draws its work as
  coming from Users, and `role:browser` finds it. An app recorded in the browser
  is labelled Browser.

- Apps in more languages and frameworks in the console, the panel and the
  services map. Java by its release (`Java 21 · Spring Boot 4.1`, `Java 8` for
  1.8) and Kotlin by Kotlin's own version. OpenTelemetry's other languages read
  as people write them (.NET, C++, PHP, Ruby, Rust, Swift, Erlang, and Deno by
  its runtime). Marks for Spring, Ktor, Quarkus, Rails, Laravel, Symfony,
  ASP.NET Core, Phoenix, Actix Web, Rocket, Vapor, Fastify, Koa, Hono, Gin,
  aiohttp and Falcon, and for those languages. A trace that comes over OTLP is
  labelled with its framework from the instrumentation that recorded it: these,
  and Micronaut, Vert.x, Javalin, Helidon, Play, Starlette, Tornado, Pyramid,
  hapi, Echo, Fiber, Sinatra, Slim and Axum.

### Changed

- The panel, the console and the services map show the mark of a Node.js
  app's framework: Express, NestJS, Next.js, Nuxt, or Node.js or Bun for a
  plain server. An app the JavaScript SDK traces is labelled Node 26 or Bun
  1.3, not by OpenTelemetry's language name, nodejs.
- A trace's SQL tab is named **DB**: the tabs fit on a narrower panel.
- Search reads a quote escaped inside a quoted value (`name:"/ › click
  \"Save\""`): an action's page, named after a button, lists its calls.
- The page widget shows the framework of the app that answered a page's
  calls when the page's server didn't name one (an SPA from a dev server),
  and the panel names a Node.js trace's runtime Node, not Nodejs.
- The console refreshes every 15 seconds by default, not every 5. A choice
  you made in its refresh menu stays.
- Before a page makes its first traced request (an SPA from a dev server),
  the widget's pill says "Waiting for requests", not `GET /` at 0 ms.
- An error's local variables line up: the names take the width of the
  longest one, not a third of the frame.
- Pages leads the entry points in the sidebar: work comes in from the browser,
  then its requests, then what they start.
- A view's or an action's trace is headed by what was done on which page (CLICK
  "Save" · /books), not by its path's first word.
- A span's attribute values wrap at spaces first, and the mono ones are the size
  of the text beside them.
- The services map's entries have a mark: a globe for Clients, a terminal for
  CLI · cron, people for Users.

### Fixed

- An app's runtime in Services and on the map is its latest trace's. After an
  upgrade it read the largest version string instead (Spring Boot 4.9 over
  4.10, Java 8 over 21), and could take the language and the framework from
  different traces. An upgraded app stays one app, as before.

- The page widget's text on a page that isn't in UTF-8: its arrows and dots
  came out garbled, as the agent served `widget.min.js` without a charset and
  the page read it in its own encoding. The agent names UTF-8 for every text
  file it serves now.

## 0.1.1 (2026-10-13)

### Changed

- The Services map fits the width it has until you pick a zoom yourself: a
  project with several apps no longer opens with its diagram cut off on the
  right.
- The Share dialog says what a file without values keeps: the trace's
  shape, timings and issues.
- The Issues page and the API describe the issues as they are now: N+1 and
  duplicate calls, slow queries and calls, blocking calls, transactions.
- The README and the PyPI page install with `pip install tracepanel`, with
  no `--pre`.

## 0.1.0 (2026-10-13)

### Added

- An RPC section in the console: the calls the app served over gRPC and
  other RPC systems, by method (`helloworld.Greeter/SayHello`), with calls,
  failures, p95 and a page per method, as the other entry points have. An
  OTLP root server span with `rpc.system` is a trace of the new kind `rpc`,
  named `Service/Method`, with `rpc.*` attributes. `GET /api/rpc` lists the
  methods, `/api/counts` counts them, and `rpc:` and `system:` search them.
- A new issue, `slow-call`: a datastore query (MongoDB, Elasticsearch,
  DynamoDB, Cassandra and the like) over `slow_sql_ms`, or an RPC call such
  as gRPC over `slow_http_ms`, which was a `slow-http` until now. A slow
  MongoDB query's hint names the index its filter and sort need, as the
  shell creates it (`db.users.createIndex({"email": 1})`): without one,
  MongoDB reads the whole collection (COLLSCAN in `explain()`).
- Share a trace as one HTML file. **Share** on a trace's page in the console,
  or its icon in the panel's bar, downloads the console itself with the trace
  and the traces linked to it inside: it opens in any browser, read-only, with
  no agent and no network (about 0.7 MB: the console inside is gzipped), for a
  teammate, a pull request or a bug report. By default it leaves out what
  stays local on the way to Tracepanel Cloud: query parameters, email bodies,
  a user's name and email, log fields and the local variables of errors.
  **Include values** keeps them, with the plans of slow queries. The agent
  serves the data at `GET /api/snapshot/{id}`.
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

- Repeats of a system's calls get that system's way to batch them: `$in` or
  `$lookup` for MongoDB, `_mget` and `_msearch` for Elasticsearch,
  `BatchGetItem` for DynamoDB, `SendMessageBatch` for SQS, a single flush for
  Kafka, confirms waited for once for RabbitMQ. Other systems keep their
  family's hint.
- A datastore call (MongoDB, Elasticsearch and the like) can keep its
  values apart from its statement, as SQL does: with `db.params_hash` on
  the span, two calls are the same only with the same values too. An SDK
  then puts the query's shape in `db.statement` and its values in
  `db.params`, which stay on this machine.
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
