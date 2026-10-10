---
name: docs
description: "Write or review Tracepanel's documentation in this repository. Use when editing README.md, CONTRIBUTING.md, SECURITY.md, PYPI.md, CHANGELOG.md, schema/README.md, or a comment or doc comment in crates/ or scripts/, and before committing such a change. Covers the voice, what belongs where, and the checks that keep it true."
---

# Writing Tracepanel's documentation

The documentation serves two readers: someone deciding whether to try
Tracepanel, and someone using it. Both need a clear statement of what happens,
next to code they can run.

## The voice

Write as you would explain a thing to a peer. Address the reader as "you", use
contractions, and keep one idea per sentence.

- **Closers**: end a section when its point is made. No clever wrap-up.
- **Marketing words**: no *seamless*, *powerful*, *blazing-fast*,
  *effortless*, *modern*. Give a number or a behaviour instead.
- **Filler**: no *simply*, *just*, *easily*, *obviously*, *of course*.
- **First person**: no *we*, *our*, *let's*. Speak of Tracepanel, the agent,
  the panel, or the reader.
- **Personification**: code doesn't "want" or "know". It records, sends,
  returns, raises.
- **Active voice**: "the agent finds the issue", not "the issue is found".
- **Plain verbs**: *starts*, *ends*, not *spins up*, *ends up*.
- **Punctuation**: no em-dashes, semicolons or exclamation marks in prose. Use
  full stops.

Put identifiers, commands, paths, settings and package names in backticks:
`tracepanel run`, `.tracepanel/`, `DEBUG`. Write the product as Tracepanel and
the package, command and paths as `tracepanel`. Wrap prose at 80 columns.

## What the public pages say

- **Python only**, for now: install and usage for Django, FastAPI, Flask,
  Starlette and Falcon. Leave other languages out of the how-to.
- **Local only**: Tracepanel as it runs on the developer's machine. No hosted
  service, no plans, no private repositories.
- **Install lines** use `pip install`. The reader picks their own installer.

## Headings

A heading matches what the reader searches for:

| Kind | For | Example |
| --- | --- | --- |
| Imperative verb | A task | `Install`, `Run without changing your code` |
| Noun phrase | A concept or a reference | `Privacy`, `Platforms`, `Issues it finds` |
| Question | Troubleshooting | `Why is there no badge?` |

Use sentence case, no trailing colon, and the same word for the same thing on
every page. When a heading changes, fix the links to it.

## Writing a section

Answer three questions, in this order:

1. **Is this mine?** The situation in the reader's words: "a Celery worker", not
   "a non-HTTP execution context". Say when it doesn't apply, so the reader can
   leave early.
2. **What do I do?** The shortest path: a command to run, a line to add.
3. **What changes for me?** What the reader sees after, and how to undo it.

How it works inside comes last, in a sentence or two, and only where it changes
what the reader types.

## Where things go

- **`README.md`**: what Tracepanel does, how to install it for each framework,
  what the reader sees, the issues it finds, privacy, platforms, links. It is
  the page on GitHub.
- **`PYPI.md`**: the `tracepanel-agent` package's page on PyPI. Short: what the
  agent is, that the `tracepanel` package installs it, `tracepanel dev`.
- **`CONTRIBUTING.md`**: how to build, test and change this repository.
- **`CHANGELOG.md`**: what changed in each version (see the `release` skill).
- **`schema/README.md`**: the contracts in `schema/`, for someone sending traces
  or reading the API.
- **How the agent works inside** (its processes, protocol, crates) is not
  documentation for users. Keep it in doc comments next to the code it
  describes, not in these pages.

## Code blocks

Every Python block runs as written: with its imports, or as a continuation of
the block before it on the same page. A comment in a block stays on one line.
Run a block you write or change:

```bash
cd /tmp && uv run --with tracepanel python snippet.py
```

## Checks

Before committing a change to a page or a comment:

```bash
uv run --no-project --with ruff scripts/lint_docs.py
```

It checks the prose rules above that a machine can catch, the width, and the
formatting of the Python blocks. Everything else is judgement, and belongs to
review.
