# tracepanel-agent

The agent of [Tracepanel](https://github.com/tracepanel/tracepanel), a debug
toolbar for Python web apps. It receives your app's traces, finds N+1 queries,
duplicate and slow SQL, long transactions and errors, keeps everything in your
project's `.tracepanel/` directory, and serves the panel and the console.

You don't install it yourself. `pip install tracepanel` (or `django-tracepanel`)
brings it, and the first traced request starts it. To run it in the
foreground, with the console on http://127.0.0.1:8765/:

```bash
tracepanel dev
```

It gives AI coding agents your traces over MCP too: `tracepanel mcp`.

Your traces stay on your machine. Licensed under the Apache License 2.0.
