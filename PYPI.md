# tracepanel-agent

The agent of [Tracepanel](https://github.com/tracepanel/tracepanel), which
collects the traces and logs of your app on your machine. It receives every
request, job and command with its SQL queries and log lines, finds N+1 queries,
duplicate and slow SQL, long transactions and errors, keeps everything in your
project's `.tracepanel/` directory, and serves the panel and the console.

You don't install it yourself. `pip install tracepanel` (or `django-tracepanel`)
brings it, and the first traced request starts it. To run it in the
foreground, with the console on http://127.0.0.1:8765/:

```bash
tracepanel dev
```

It gives AI coding agents your traces over MCP too: `tracepanel mcp`.

Your traces stay on your machine.

The agent is under the Functional Source License (FSL-1.1-ALv2). You can use it
for any purpose except a commercial product or service that competes with
Tracepanel. Each version becomes Apache License 2.0 two years after its
release.
