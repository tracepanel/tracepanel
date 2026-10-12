# Changelog

## Unreleased

### Added

- Outgoing HTTP calls and cache calls (Redis) get the same analysis as SQL.
  Calls a loop makes to one endpoint (`GET api.example.com/users/{id}`) or one
  key pattern (`user:{id}`) are an N+1. The same read made twice is a
  duplicate. An HTTP call slower than `slow_http_ms` (500 ms by default) is a
  new issue, `slow-http`.
- The console shows outgoing HTTP calls: an HTTP calls tab with the calls
  grouped by endpoint, a tile with their count and time, a lane on the
  timeline, and "External calls" in the call tree's time breakdown. Similar
  HTTP calls fold into one row of the call tree, like queries.
- An HTTP calls page, next to Database: the endpoints the app calls (method,
  host and path with ids as `{id}`), with their calls, requests, failures,
  most calls in one request, total and slowest time, and the line of code
  that calls them. It links to the requests that made the call (`call:<key>`
  in the search) and shows in the sidebar once the app has made a call.

### Changed

- The store's format is now version 15. A store from an earlier version is
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
