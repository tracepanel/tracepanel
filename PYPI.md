# tracepanel-agent

The agent of [Tracepanel](https://github.com/tracepanel/tracepanel), which
collects the traces and logs of your app on your machine. It receives every
request, job, command and gRPC call with its SQL queries, Redis commands,
cache calls, MongoDB and other datastore queries, messages, outgoing HTTP and
gRPC calls and log lines. It finds N+1 queries and calls, duplicates, slow SQL
and slow calls, large results, blocking calls in async code, task queue waits,
long transactions and errors, with a hint for each system. It keeps everything
in your project's `.tracepanel/` directory and serves the panel and the
console, where a trace can be shared as a single HTML file.

You don't install it yourself. The Tracepanel SDKs bring it (for Python,
`pip install tracepanel`), and the first traced request starts it. To run the
agent by hand, with the console on http://127.0.0.1:8765/:

```bash
tracepanel-agent --serve 127.0.0.1:8765
```

It takes OpenTelemetry spans over OTLP/HTTP too, on `127.0.0.1:4318`, where
OpenTelemetry's exporters send them by default: a service in any language shows
in the console. And it gives AI coding agents your traces over MCP:
`tracepanel-agent mcp`.

Your traces stay on your machine.

The agent is free to use on your projects, at work or on your own. It is fair
source, under the Functional Source License (FSL-1.1-ALv2). Use it, change it
and share your changes. The one thing it reserves is offering Tracepanel itself
as a commercial product or hosted service. Each version becomes Apache License
2.0 two years after its release.
