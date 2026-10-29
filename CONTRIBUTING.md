# Contributing

This repository holds the Tracepanel agent, written in Rust (`crates/`), and the
panel, console and widget it serves, written in React (`ui/`). The Python
package that records traces lives in the tracepanel-python repository.

## Build and test the agent

Rust is pinned in `rust-toolchain.toml`. Rustup installs it on the first
`cargo`.

```bash
cargo build                                # embeds ui-dist/ and schema/
cargo test                                 # the crates and schema/examples
cargo clippy --all-targets -- -D warnings
cargo fmt --all
```

To run the agent on a project's traces, with the console on
http://127.0.0.1:8765/, stop the agent the project started first. A store has
one agent at a time.

```bash
cargo run -p tracepanel-agent -- --dir path/to/project/.tracepanel --serve 127.0.0.1:8765
```

A tracepanel-python checkout next to this repository builds the agent from here
when you run `uv sync` there. Its tests check the agent through the console's
API.

## Measure what it costs

Each crate's `benches/` measures what the agent does per trace: decoding a
frame, finding the issues, writing to the store, the console's reads, OTLP.
The traces are `schema/examples`. CodSpeed runs them on every pull request,
counts the instructions each one takes and comments when one costs more.
`cargo bench` runs them on your machine with divan's timer.

## Change the UI

```bash
cd ui
pnpm install
pnpm dev      # the console with hot reload, against an agent on :7700
pnpm lint     # Biome and strict TypeScript
pnpm fmt
pnpm api      # packages/ui/src/api.gen.ts from schema/openapi.yaml
```

For `pnpm dev`, start the agent with `--serve 127.0.0.1:7700`.

To work on the UI or the widget against a real app, use a debug build of the
agent. It reads `ui-dist/` from disk on every request, so a refresh of the page
shows the change, with no rebuild of the agent:

```bash
cargo build                    # once: target/debug/tracepanel-agent
cd ui && pnpm watch            # rebuilds into ui-dist/ on every save
```

Then start the app with that agent. Stop the agent the app started before, or
the app keeps using it:

```bash
TRACEPANEL_AGENT_BIN=path/to/tracepanel/target/debug/tracepanel-agent python manage.py runserver
```

The agent embeds `ui-dist/`, the built UI. After changing `ui/`, run
`scripts/ui.sh` and commit `ui-dist/` with the change. CI checks that
`ui-dist/` matches `ui/`.

### Test the console in a browser

`ui/e2e` opens the console in Chromium against a real agent: a debug build of
this checkout, with a store of its own. Before the tests, it sends the agent
the traces in `schema/examples` and a few more it makes: a page's views and
actions, a task, a job. A test fails on an error in the page's console, an
exception the page didn't catch, or an answer of 5xx.

```bash
cargo build                                   # target/debug/tracepanel-agent
cd ui/e2e
pnpm exec playwright install chromium         # once
pnpm e2e                                      # pnpm e2e --ui: step through
```

The debug agent reads `ui-dist/` from disk, so run `scripts/ui.sh` after
changing `ui/`. CI runs the same tests when the crates or the UI change, and
keeps Playwright's report and traces when one fails.

## Change what an SDK sends

`schema/` holds what the SDKs, the agent and the UI agree on: the trace
(`trace.schema.json`), the console's API (`openapi.yaml`), the search fields
(`search.json`), the store (`store.sql`), and real traces from each SDK with the
issues they must give (`examples/`).

A change in what an SDK sends gets an example. Record it with
`tracepanel-agent --record DIR`, then add it to `schema/examples/` and to
`expected.json`.

## Write the documentation

Read `.claude/skills/docs/SKILL.md` for the voice and the rules, then check the
pages:

```bash
uv run --no-project --with ruff scripts/lint_docs.py
```

## License of contributions

This repository is under FSL-1.1-ALv2, and DevRealm OÜ also uses its code in
the Tracepanel cloud. By opening a pull request you license your contribution
to DevRealm OÜ under the Apache License 2.0, and to everyone else under this
repository's license. You keep the copyright.

## Build the package

`uv build` makes the sdist and, from it, a wheel for this machine. Maturin is
the build backend. Release files come from CI only: the `Wheels` workflow builds
and checks every platform's wheel, and `Release` publishes them with
`uv publish` on a tag. Releasing is described in
`.claude/skills/release/SKILL.md`.

The same binaries go to npm. `scripts/npm.py` makes one package per platform
from the wheels, `@tracepanel/agent-<platform>`, and `@tracepanel/agent`, which
lists them as optional dependencies and runs the one npm installed. `Wheels`
packs them and installs them on Linux, macOS and Windows. `npm` publishes them
once `Release` has published a tag to PyPI, from that run's packages: one build
for both registries, approved once, in `Release`'s `pypi` environment. Run by
hand with a version on PyPI, it makes the packages from that release's wheels.
It publishes through npm's trusted publishing, with no token: each package
trusts this repository's `npm.yml` in the `npm` environment.

They go to Maven Central too, for the Java SDK. `scripts/maven.py` takes each
binary out of its npm package and lays out `dev.tracepanel:tracepanel-agent`,
a POM with the binary of each platform beside it under the platform's npm name
as its classifier, as protoc is published. `Maven Central` (`maven.yml`) signs
the files and uploads them through the Central Portal once `Release` has
published a tag to PyPI, or by hand for a version on PyPI. The Central Portal
has no trusted publishing: the token and the signing key are secrets of the
`maven-central` environment.

## Update dependencies

After changing Rust or UI dependencies, regenerate the licenses the agent ships
with. This needs cargo-about at the version `scripts/notices.py` names
(`cargo install --locked cargo-about@0.9.3 --features cli`), as CI has.

```bash
uv run scripts/notices.py
```
