---
name: release
description: "Cut a release of the tracepanel-agent package from this repository. Use when asked to release, publish, bump the version, or write release notes. Covers the version in two files, the tag that publishes, the order of the packages, and the changelog."
---

# Releasing tracepanel-agent

A release is a version bump, a changelog entry and a tag. Publishing is
automatic: `.github/workflows/wheels.yml` runs on a tag that names a version,
builds a wheel for every platform and the sdist, runs each wheel on its
platform, checks the tag against the version, and uploads to PyPI with
`uv publish` through trusted publishing. No token lives in the repository.

## Before you start

The tag builds what the commit holds, so start from a clean tree with green CI:

```bash
cargo test
cargo clippy --all-targets -- -D warnings
uv run scripts/notices.py --check
uv run --no-project --with ruff scripts/lint_docs.py
```

## The version, in two files

The version lives in `Cargo.toml` (`[workspace.package] version`, semver) and in
`pyproject.toml` (`[project] version`, PEP 440). They write a pre-release
differently and must name the same version:

| Release | `Cargo.toml` | `pyproject.toml` | Tag |
| --- | --- | --- | --- |
| Alpha | `0.1.0-alpha.1` | `0.1.0a1` | `0.1.0a1` |
| Beta | `0.1.0-beta.1` | `0.1.0b1` | `0.1.0b1` |
| Release | `0.1.0` | `0.1.0` | `0.1.0` |

The workflow compares the three as versions and stops before building
anything published if they disagree. Run `cargo build` after the bump so
`Cargo.lock` follows.

## Choosing the number

The project is on `0.x`, so the minor number carries the weight:

- **Something breaks** for a user who upgrades: bump the minor. A changed
  protocol, a setting that means something else, a store format the old agent
  can't read. `0.1.3` to `0.2.0`.
- **Nothing breaks**: bump the patch. `0.1.3` to `0.1.4`.

Pip and uv install a pre-release only when asked for it, or when another
package pins it exactly, as `tracepanel` pins `tracepanel-agent`.

## The packages, in order

`tracepanel` (the Python package) depends on `tracepanel-agent` at exactly its
own version, and `django-tracepanel` on `tracepanel`. Release them in that
order, each after the one before is on PyPI:

1. `tracepanel-agent`, from this repository.
2. `tracepanel`, with its version and its `tracepanel-agent==` pin bumped.
3. `django-tracepanel`.

## The release itself

```bash
# edit Cargo.toml and pyproject.toml, then:
cargo build
# write the CHANGELOG.md entry
git commit -a -m "Release 0.1.0a1"
git push
git tag 0.1.0a1 && git push origin 0.1.0a1
```

The tag has no `v`. The run waits in the `pypi` environment for a reviewer to
approve the upload.

To try the whole path first, run the `Wheels` workflow by hand with
`testpypi` checked. It publishes the run's files to TestPyPI and skips a
version already there.

## The changelog

`CHANGELOG.md` holds the history, newest version first. The entry goes in
before the tag. A version has the date it was released and the headings it
needs, `Added`, `Changed`, `Fixed`, `Removed`, in that order, none of them
empty.

Write it for someone deciding whether to upgrade, in the voice of the `docs`
skill. A breaking change says what to do differently. A fix says what was
wrong, so a reader can tell whether it affected them. Leave out what nobody
outside the repository can see: refactors, tests, lockfile updates.

The GitHub release notes carry the same text.

## Once, on the publishing side

Trusted publishing needs a publisher on PyPI (owner `tracepanel`, repository
`tracepanel`, workflow `wheels.yml`, environment `pypi`), the same on TestPyPI
with the environment `testpypi`, and both environments on GitHub. Without them
the run is green up to the upload and fails there with `invalid-publisher`. The
`pypi` environment is where the required reviewer goes.
