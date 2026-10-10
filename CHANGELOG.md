# Changelog

## 0.0.1a1 (2026-10-10)

The first release of the Tracepanel agent.

### Added

- The agent receives the traces of a project's processes over a local socket,
  one agent per project, started by the first trace and stopped after 30
  minutes unused.
- It finds N+1 queries, duplicate and slow SQL, long transactions, work done
  inside a transaction, htmx mistakes and errors, each with the line of code
  it comes from and a fix in the words of the ORM.
- It keeps the newest traces in `.tracepanel/` in the project, and serves the
  panel, the console and their API on `127.0.0.1`.
- `tracepanel-agent mcp` gives AI coding agents the traces over MCP: recent
  traces, one trace in a few lines, the next trace that matches, and a
  comparison of two traces.
- Wheels for Linux (x86_64, arm64, armv7, armv6, i686, ppc64le, s390x,
  riscv64), macOS and Windows, and an sdist for other platforms.
