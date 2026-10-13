# Tracepanel

[![CI](https://github.com/tracepanel/tracepanel/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/tracepanel/tracepanel/actions/workflows/ci.yml)
[![CodSpeed](https://img.shields.io/endpoint?url=https://codspeed.io/badge.json)](https://app.codspeed.io/tracepanel/tracepanel)

**See what your app does on every request.** Tracepanel collects the traces
and logs of your app on your machine. Every request, background job and command
comes with its SQL queries, its calls to Redis, caches and other services, its
log lines and errors. Tracepanel finds N+1 queries and calls, slow SQL, blocking
calls in async code and more, and names the line of code to fix.

The first SDK is for Python: Django, FastAPI and Flask. A service in another
language shows through OpenTelemetry.

It runs while you develop. Nothing leaves your machine.

## Install

```bash
pip install tracepanel
```

installs the Python SDK and the agent it starts, at the same version. The
documentation is at [tracepanel.dev/docs](https://tracepanel.dev/docs).

## Run without changing your code

`tracepanel run` turns Tracepanel on for one command and adds nothing to the
project. For example:

```bash
tracepanel run python manage.py runserver   # Django
tracepanel run uvicorn app.main:app         # FastAPI, Starlette
tracepanel run flask --app app run          # Flask
tracepanel run gunicorn app:app             # Falcon
tracepanel run celery -A app worker         # a worker
```

## What you see

Open any page of your app. A badge in the corner shows the request's status,
time, queries and issues. Click it to open the panel. The panel lists every
request the page made, including `fetch()` calls, each with its call tree, SQL
and logs.

The console at `/__tracepanel__/` covers the whole app. It lists HTTP
endpoints, GraphQL operations, background tasks, commands, WebSockets and the
gRPC methods it serves, with charts over time and one search across all of
them.

Every system your app calls has a page of its own: the database, Redis, the
cache, HTTP calls, and MongoDB, Kafka, gRPC or whatever else it talks to. Each
lists the calls grouped by what they repeat, with the same columns and
filters. The Services page draws the project's architecture from its calls:
which app calls which database, cache, broker or API, and which apps call each
other. It copies as Mermaid, for a README or an issue.

Logs are in the console too, each line linked to the request, job or command
that wrote it. The SDK reads them from the standard logging, so there is no
handler to add and your logging configuration stays as it is. Search them by
level (`level>=warning`), logger (`blog.*`), the route, path or user of the
request, or any field passed in `extra=`, such as `extra.order_id:42`.

A task or a command has no page, so each one prints a summary line in the
terminal with a link to its trace.

## Issues it finds

Each issue names the line of your code that caused it and shows the fix with
your ORM's API.

| Issue | What it is |
| --- | --- |
| N+1 queries and calls | the same query repeated per row, with the `select_related()` (or `joinedload()`) that removes it; the same per item for Redis, a cache, HTTP and other services |
| Duplicates | the same query or call, with the same parameters, more than once in a request |
| Slow SQL | a query over the threshold, with its plan (`EXPLAIN`) one click away, and why no index helps a `LIKE '%…'` |
| Slow HTTP calls | an outgoing call over the threshold |
| Slow calls | a MongoDB, Elasticsearch or other datastore query, or a gRPC call, over the threshold; for MongoDB, the index its filter needs |
| Large results | a SELECT without a LIMIT that read many rows |
| Blocking calls | a synchronous query or call in async code, which holds up every other request |
| Queue waits | a task that waited for a free worker |
| Long transactions | a transaction that holds its locks too long, and the work inside it |
| Work inside a transaction | an email sent or a task queued before `COMMIT` |
| htmx mistakes | a redirect htmx swaps into the page, a whole page in a fragment |
| Errors | the exception, its stack with your frames and their source, the request that raised it |

## How it works

Your app records each request, task and command, and sends it after the
response to the Tracepanel agent. The agent is one small process per project.
The first trace starts it, and it exits after 30 minutes unused. It finds the
issues, keeps the traces in `.tracepanel/` in your project, and serves the panel
and the console. Your app does no analysis and keeps no store.

To run the agent in the foreground, with the console on http://127.0.0.1:8765/:

```bash
tracepanel dev
```

## OpenTelemetry

The agent also takes OpenTelemetry spans over OTLP/HTTP, on
`127.0.0.1:4318`, where OpenTelemetry's exporters send them by default. A
service that exports its traces with OpenTelemetry shows in the console while
the agent runs, with no Tracepanel SDK in it. The agent reads the spans by
OpenTelemetry's semantic conventions and finds the same issues in them.

Calls between services link their traces by the W3C trace context, whether
each uses this SDK or OpenTelemetry. A request shows the trace of the service
it called, and the Services page draws the call.

## Use with an AI coding agent

```bash
claude mcp add --scope project tracepanel -- uv run tracepanel mcp
```

Claude Code, Cursor or Codex then gets tools to find a trace, read it in a few
lines, wait for the request it made and compare the traces before and after a
fix. A trace's 151 SQL queries fold into lines such as
`sql SELECT auth_user ×50 · 0.7 ms  [n+1] — blog/views.py:28`. The answers
leave out SQL parameters and local variables unless you start
`tracepanel mcp` with `--values`.

## Privacy

Traces stay in `.tracepanel/` in your project. Add it to `.gitignore`. By
default the console listens on `127.0.0.1`, and the agent takes traces from
this machine only. Tracepanel masks values under names that look secret, such
as passwords, tokens and keys.

## Platforms

- Linux: x86_64, arm64, armv7, armv6, i686, ppc64le, s390x, riscv64 (glibc and
  musl)
- macOS: Apple silicon and Intel
- Windows: x86_64, x86, arm64

Python 3.11 and newer, Django 5.2 and newer.

## Links

- [CHANGELOG.md](CHANGELOG.md): what changed in each version
- [CONTRIBUTING.md](CONTRIBUTING.md): building and testing this repository

## License

Tracepanel is free to use on your projects, at work or on your own. The SDKs
that record traces, such as the Python package, are under the MIT License.

The agent and its console are fair source, under the [Functional Source
License](LICENSE) (FSL-1.1-ALv2). Use them, change them and share your changes.
The one thing it reserves is offering Tracepanel itself as a commercial product
or hosted service. Each version becomes Apache License 2.0 two years after its
release.
