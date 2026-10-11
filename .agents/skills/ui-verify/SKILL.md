---
name: ui-verify
description: Prove the tracepanel UI (ui/ workspace) still runs, reads consistently, and stays accessible. Drives the app with agent-browser and records evidence for a PR. Use before opening a UI PR, after a styling or component refactor, or when asked to verify a screen.
---

# UI verify

Verify that the UI runs, looks consistent, and stays accessible. The evidence goes in a named folder for the PR, so the review sees the same screens the author saw.

## What you need

- `ui/` dependencies installed: run `pnpm install` from `ui/`
- A data source behind the dev server's `/api` proxy (the vite config proxies it to `http://localhost:7700`):
  - today this is the local tracepanel agent (Rust server crate), started as the root README says
  - a schema-aligned mock server replaces this requirement in a later guardrail PR; when it exists, prefer it for deterministic screens

## Start

All commands run from `ui/`:

```bash
AGENT_BROWSER_SESSION="$(agent-browser session id --scope worktree --prefix ui-verify)"

pnpm dev &   # vite in apps/local, typically http://localhost:5173
agent-browser --engine lightpanda --session "$AGENT_BROWSER_SESSION" open http://localhost:5173
agent-browser --engine lightpanda --session "$AGENT_BROWSER_SESSION" wait --text "<marker for a settled screen>"
```

Wait on a marker the screen itself owns (its heading, or the last row of a settled list), not on `networkidle`: the app polls.

## Record, per screen

For each screen: the traces overview at a minimum, plus every screen the change touched.

```bash
agent-browser --engine lightpanda --session "$AGENT_BROWSER_SESSION" snapshot -i
agent-browser --engine lightpanda --session "$AGENT_BROWSER_SESSION" screenshot --full apps/local/verify/<pr-slug>/<screen>.png
agent-browser --engine lightpanda --session "$AGENT_BROWSER_SESSION" a11y --tags wcag2a,wcag2aa --json
agent-browser --engine lightpanda --session "$AGENT_BROWSER_SESSION" console
```

## Pass rules

The run fails when any of these hold:

- `a11y` reports WCAG 2.0 or 2.1 AA violations that the touched screen owns
- `console` shows an error that the touched screen emits
- the screen's screenshot drifts from its previous evidence in a way the change does not explain
- a sibling screen (untouched) breaks: check one sibling besides the touched screens

## Report

End the run with one line:

- looked at: the screen list
- a11y: pass, or the violation summary
- console: pass, or the error summary
- notes: drift the change does not explain, with before and after screenshot paths

Delete nothing from `ui/apps/local/verify/` without naming the replacement in the PR body.
