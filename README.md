# Tracepanel

[![CI](https://github.com/tracepanel/tracepanel/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/tracepanel/tracepanel/actions/workflows/ci.yml)
[![CodSpeed](https://img.shields.io/endpoint?url=https://codspeed.io/badge.json)](https://app.codspeed.io/tracepanel/tracepanel)

Tracepanel shows what your app does on each request, background task and
command: its SQL queries, its calls to Redis, caches, HTTP APIs and other
services, its logs and its errors. It finds N+1 queries, duplicates, slow SQL
and other issues, and names the line of code that caused each one.

You read it in a panel docked on your app's pages and in a console at
`/__tracepanel__/`. It runs on your machine while you develop, and the traces
stay in your project.

[![A 40-second demo: Swagger UI's Try it out on an endpoint, and the panel docked under it with the request's call tree, an N+1 with its query plan, a background task, its profile, and the same call after the fix](https://raw.githubusercontent.com/tracepanel/tracepanel/main/assets/demo-video.jpg)](https://tracepanel.dev/video/demo.mp4)

40-second demos: [Django](https://tracepanel.dev/video/demo.mp4),
[Next.js](https://tracepanel.dev/video/demo-js.mp4),
[Spring Boot](https://tracepanel.dev/video/demo-java.mp4).

This repository holds the agent, the console and the panel. Your app records
traces through an SDK, and the SDK starts the agent.

## Get started

Pick the SDK for your app's language:

| Language | Install | Frameworks | Repository | Docs |
| --- | --- | --- | --- | --- |
| Python | `pip install tracepanel` | Django, FastAPI, Starlette, Flask, Falcon, any ASGI or WSGI app | [tracepanel-python](https://github.com/tracepanel/tracepanel-python) | [Python](https://tracepanel.dev/docs/python) |
| Django | `pip install django-tracepanel` | Django 5.2, 6.0 and 6.1 | [django-tracepanel](https://github.com/tracepanel/django-tracepanel) | [Django](https://tracepanel.dev/docs/django) |
| JavaScript | `npm install @tracepanel/js` | Express, Fastify, Koa, Hono, NestJS, Next.js, Nuxt, Bun, an SPA on Vite | [tracepanel-js](https://github.com/tracepanel/tracepanel-js) | [JavaScript](https://tracepanel.dev/docs/javascript) |
| Java, Kotlin | `dev.tracepanel:tracepanel-spring-boot` or `dev.tracepanel:tracepanel-ktor` on Maven Central | Spring Boot 3.5 and 4, Ktor 3 | [tracepanel-java](https://github.com/tracepanel/tracepanel-java) | [Java](https://tracepanel.dev/docs/java) |

Each SDK's README shows the setup for its frameworks. Once it is on, open a
page of your app and click the badge in the corner.

A service in another language needs no SDK. Export its traces with
OpenTelemetry and they show in the console (see
[OpenTelemetry](#opentelemetry)).

## What it shows

The panel lists the requests a page made, its `fetch()` calls included, each
with its call tree, SQL, logs and issues. Here a Next.js store lists its
products, and loads each product's category, brand and reviews in a query of
its own:

![A Next.js app's Swagger UI with an endpoint run, and the panel docked under it with the request's call tree and its three N+1 queries](https://raw.githubusercontent.com/tracepanel/tracepanel/main/assets/panel-call-tree.png)

Each issue names the line that ran it and the fix. Here a Spring Boot store,
with the `@Async` task the request queued:

![The panel docked under Swagger UI on a Spring Boot request's Issues tab: each N+1 with the line in CatalogController.java it comes from and the fix](https://raw.githubusercontent.com/tracepanel/tracepanel/main/assets/panel-issues.png)

The console covers the whole app: HTTP endpoints, GraphQL operations,
background tasks, commands, WebSockets, RPC methods and the pages users viewed
in the browser. Each has charts over time and the slowest and failing ones:

![The console's HTTP page: requests and latency over time, the slowest and the failing endpoints](https://raw.githubusercontent.com/tracepanel/tracepanel/main/assets/console-http.png)

Every system the app calls has a page: the database, Redis, the cache, HTTP
calls, MongoDB, AWS, LLM calls, file storage and more. The Services page draws
the apps and the systems they call, and copies the diagram as Mermaid:

![The Services page: Python, Node and browser apps, the databases, caches and brokers they call, and an arrow for each call](https://raw.githubusercontent.com/tracepanel/tracepanel/main/assets/console-services.png)

What else is in a trace:

- Linked traces. A task links to the request that queued it, and a call to
  another app links to that app's trace, by the W3C trace context.
- Logs from the language's usual loggers, each line on the request or task
  that wrote it, with one search across them. A trace's Logs tab lists its
  whole chain of calls, each line with its app, or what is under one row of
  the call tree, added up by level, app and logger. The DB, HTTP calls and
  Issues tabs do the same, and an N+1 across apps (a service's query once
  per call of a resolver) is one issue. The Profile tab shows each app's
  profile of the chain.
- Errors with their stack and the source of your frames, and in Python and
  Node their local variables.
- `EXPLAIN` of a query, one click from the query.
- Profiles on request: where the time went as a flame graph, and memory in
  Python and Node.
- LLM calls with their model, tokens and estimated cost.

A trace can be shared as one HTML file that opens in any browser.

## Issues it finds

| Issue | What it is |
| --- | --- |
| N+1 queries and calls | the same query or call once per item, for SQL, Redis, caches, HTTP, MongoDB, AWS and other systems |
| Duplicates | the same read with the same values more than once in a trace |
| Slow SQL | a query over the threshold (2 s on an analytical warehouse), with its plan |
| Slow HTTP and datastore calls | an outgoing call over the threshold, and for MongoDB the index its filter needs |
| Large results | a `SELECT` without a `LIMIT` that read many rows |
| Long transactions | a transaction that holds its locks too long |
| Work before commit | a task queued, an email sent or an HTTP call made inside a transaction |
| Blocking calls | a synchronous call in async code, which holds up the event loop |
| Queue waits | a task that waited for a free worker |
| Risky migrations | a Django migration that locks or rewrites a table, or can't be undone |
| htmx mistakes | a redirect htmx swaps into the page, a whole page in a fragment |
| Errors | an unhandled exception, grouped across requests |

The fix uses your ORM's API where the agent knows it: Django, SQLAlchemy,
Prisma, Drizzle, TypeORM, Sequelize, Knex, Mongoose, Hibernate and Exposed.
[Issues](https://tracepanel.dev/docs/issues) lists what triggers each one.

The SDKs also fail a test that makes an N+1 or duplicate queries: pytest in
Python, Vitest in JavaScript and JUnit in Java.

## The agent

Each project has one agent, `tracepanel-agent`. It takes the traces from your
app, finds the issues, keeps the traces in `.tracepanel/` in your project and
serves the panel and the console. Your app does no analysis and keeps no
store.

You don't install the agent yourself. `pip install tracepanel` and
`npm install @tracepanel/js` bring it, and the Java SDK downloads it from
Maven Central the first time. The first trace starts it, and it exits after 30
minutes unused. To install it alone:

```bash
pip install tracepanel-agent
# or
npm install @tracepanel/agent
```

To run it in the foreground from your project's directory, with the console on
http://127.0.0.1:8765/:

```bash
tracepanel-agent --serve 127.0.0.1:8765
```

| Command | What it does |
| --- | --- |
| `tracepanel-agent --serve HOST:PORT` | runs the agent and serves the console at that address |
| `tracepanel-agent mcp` | runs the MCP server for AI coding agents |
| `tracepanel-agent licenses` | prints the agent's license and the notices of the code it is built from |
| `tracepanel-agent --help` | lists the options, such as `--dir` for the store and `--otlp` |

The Python and JavaScript SDKs also have `tracepanel dev`, which runs the agent
in the foreground, and `tracepanel run <command>`, which turns Tracepanel on for
one command.

## OpenTelemetry

The agent takes OpenTelemetry spans over OTLP/HTTP on `127.0.0.1:4318`, where
OpenTelemetry's exporters send them by default. A service in any language that
exports its traces with OpenTelemetry shows in the console while the agent
runs. The agent reads the spans by OpenTelemetry's semantic conventions and
finds the same issues in them. `--otlp HOST:PORT` moves the address, and
`--otlp off` turns it off. Without `--otlp`, the agent reads the address from
`TRACEPANEL_OTLP` (`HOST:PORT` or `off`).

A Rust app shows through tracing-opentelemetry. tower-http's `TraceLayer`
request span is a request, named by its method and path. The queries sqlx logs
at `sqlx::query=debug` are SQL queries, analyzed as any other, and the other
`tracing` events are the trace's log records.

Only one agent on a machine gets a port. With several projects running at
once, the first project's agent takes `127.0.0.1:4318`, and the others take
no OTLP. Give each other project a port of its own in its environment, where
its SDK starts the agent, and point its exporters there:

```bash
export TRACEPANEL_OTLP=127.0.0.1:4319
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4319
```

The agent writes the address it serves OTLP on to `.tracepanel/otlp.addr`.
The console shows it at the foot of the sidebar. When the port is taken, the
console names the project whose agent holds it and suggests a free one. The
agent tries the port again every 10 seconds and takes it over once the other
project's agent has stopped.

Calls between services link their traces by the W3C trace context, whether
each service uses a Tracepanel SDK or OpenTelemetry.

## AI coding agents

The agent runs an MCP server that gives Claude Code, Cursor, VS Code or Codex
your traces. Add it from your project's directory:

```bash
claude mcp add --scope project tracepanel -- tracepanel-agent mcp
```

With the Python SDK under uv, the command is `uv run tracepanel mcp`. With the
JavaScript SDK, it is `npx @tracepanel/js mcp`.

The tools find a trace, read it in a few lines, wait for the request the
coding agent makes and compare the traces before and after a fix. A trace's
151 SQL queries fold into lines such as
`sql SELECT auth_user ×50 · 0.7 ms  [n+1] — blog/views.py:28`. `get_profile`
reads a profiled trace's CPU or memory profile as text, with the hottest
functions and their lines. It then reads the profiles of the traces down its
chain of calls, one per app. The answers leave out SQL parameters and local
variables unless you start the server with `--values`. The
[AI coding agents](https://tracepanel.dev/docs/ai-agents) page lists the tools
and the setup for each editor.

## Privacy

Traces stay in `.tracepanel/` in your project. Add it to `.gitignore`. The
agent sends nothing anywhere. By default the console and the OTLP intake
listen on `127.0.0.1`, and the agent takes traces from this machine only.
Tracepanel masks values under names that look secret, such as passwords,
tokens and keys.

The SDKs turn on in development only: in the framework's debug or dev mode for
Python and Java, and unless `NODE_ENV` is `production` for JavaScript.

## Platforms

- Linux: x86_64, arm64, armv7, armv6, i686, ppc64le, s390x, riscv64 (glibc and
  musl)
- macOS: Apple silicon and Intel
- Windows: x86_64, x86, arm64

## Verify a build

Each release signs where its files came from: the wheels and the sdist, the
npm packages, and the agent's binary for each platform. pip, npm and the Java
SDK install the same binary, so one check covers all three. To check it with
the GitHub CLI:

```bash
# Installed with pip
gh attestation verify "$(which tracepanel-agent)" --repo tracepanel/tracepanel
# Installed with npm (node_modules/.bin holds a launcher, not the binary)
gh attestation verify "$(node -p "require('@tracepanel/agent').binaryPath()")" \
  --repo tracepanel/tracepanel
# Downloaded by the Java SDK
gh attestation verify ~/.cache/tracepanel/agent/VERSION/PLATFORM/tracepanel-agent \
  --repo tracepanel/tracepanel
```

A downloaded wheel, sdist or npm package checks the same way. It passes when
this repository's release workflow built the file from a tagged commit.

## Links

- [tracepanel.dev/docs](https://tracepanel.dev/docs): the documentation
- [CHANGELOG.md](CHANGELOG.md): what changed in each version
- [CONTRIBUTING.md](CONTRIBUTING.md): building and testing this repository

## License

The agent, the console and the panel are free to use under the
[Functional Source License](LICENSE) (FSL-1.1-ALv2). Each release becomes
Apache License 2.0 two years after it is published. The license reserves one
thing: offering Tracepanel itself as a commercial product or hosted service.

The SDKs are under the MIT License.
