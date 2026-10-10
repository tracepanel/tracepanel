# Tracepanel

**See what your app does on every request.** Tracepanel is a debug toolbar for
Python web apps. It traces every request, query, task and error on your
machine, finds the N+1 queries and the duplicate and slow SQL, and names the
line of code to fix.

It runs while you develop. Nothing leaves your machine.

## Install

Tracepanel turns on in development only: with `DEBUG`, in a debug server, or
under `tracepanel run`.

### Django

```bash
pip install django-tracepanel
```

```python
# settings.py
INSTALLED_APPS += ["tracepanel.django"]
```

Run the server as usual and open any page. Celery, Django REST framework,
Django Ninja, Channels, Strawberry and htmx are traced with no more setup.

### FastAPI

```bash
pip install tracepanel
```

```python
from fastapi import FastAPI

import tracepanel.fastapi

app = FastAPI(debug=True)
tracepanel.fastapi.install(app)
```

SQLAlchemy, Celery, Dramatiq, RQ and Strawberry are traced with no more setup.

### Flask

```bash
pip install tracepanel
```

```python
from flask import Flask

import tracepanel.flask

app = Flask(__name__)
tracepanel.flask.install(app)
```

Start it with `flask run --debug`. SQLAlchemy, Celery, Dramatiq and RQ are
traced with no more setup.

## Run without changing your code

`tracepanel run` turns Tracepanel on for one command and adds nothing to the
project:

```bash
tracepanel run python manage.py runserver   # Django
tracepanel run uvicorn app.main:app         # FastAPI, Starlette
tracepanel run flask --app app run          # Flask
tracepanel run gunicorn app:app             # Falcon
tracepanel run celery -A app worker         # a worker
```

## What you see

Open any page of your app. A badge in the corner shows the request's status,
time, queries and issues. Click it for the panel: every request the page made,
`fetch()` calls included, each with its call tree, SQL and logs.

The console at `/__tracepanel__/` shows everything the app did beyond one page:
HTTP endpoints, GraphQL operations, background tasks, commands and WebSockets,
with charts over time and one search across all of it.

A task or a command has no page, so each one ends with a line in the terminal:
a summary and a link to its trace.

## Issues it finds

Each issue names the line of your code it comes from and how to fix it, in the
words of your ORM.

| Issue | What it is |
| --- | --- |
| N+1 queries | the same query repeated per row, with the `select_related()` (or `joinedload()`) that removes it |
| Duplicate queries | the same query and parameters, more than once in a request |
| Slow SQL | a query over the threshold, with its plan (`EXPLAIN`) one click away |
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

## Use with an AI coding agent

```bash
claude mcp add --scope project tracepanel -- uv run tracepanel mcp
```

Claude Code, Cursor or Codex then gets tools to find a trace, read it in a few
lines, wait for the request it made and compare the traces before and after a
fix. A trace's 151 SQL queries fold into lines such as
`sql SELECT auth_user ×50 · 0.7 ms  [n+1] — blog/views.py:28`. The answers
leave out SQL parameters and variables' values unless you start it with
`--values`.

## Privacy

Traces stay in `.tracepanel/` in your project. Add it to `.gitignore`. By
default the console listens on `127.0.0.1`, and the agent takes traces from
this machine only. Values under names that look secret, such as passwords,
tokens and keys, are masked.

## Platforms

- Linux: x86_64, arm64, armv7, armv6, i686, ppc64le, s390x, riscv64 (glibc and
  musl)
- macOS: Apple silicon and Intel
- Windows: x86_64, x86, arm64

Python 3.11 and newer, Django 5.2 and newer.

## Links

- [tracepanel-python](https://github.com/tracepanel/tracepanel-python): the
  Python package
- [django-tracepanel](https://github.com/tracepanel/django-tracepanel): the
  documentation for Django
- [CHANGELOG.md](CHANGELOG.md): what changed in each version
- [CONTRIBUTING.md](CONTRIBUTING.md): building and testing this repository

## License

[Apache License 2.0](LICENSE). © DevRealm OÜ.
