# /// script
# requires-python = ">=3.11"
# ///
"""Approve a release's staged npm versions: the 15 platform packages, then @tracepanel/agent.

npm.yml stages them (npm stage publish); each goes public only when a maintainer approves it with 2FA. This finds the
release's 16 staged versions and approves them one after another with one code, asking for a new one when npm turns
the code down (it may take each code once).

    uv run scripts/npm_approve.py 0.0.2a1      # the version as on PyPI, or as npm writes it (0.0.2-alpha.1)

Needs `npm login` with an account that maintains the packages, and npm 11.15 or later. Python's standard library only.
"""

import getpass
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from npm import PLATFORMS, SCOPE, semver  # noqa: E402 (the sibling script, found through the path above)

# The platform packages first: once @tracepanel/agent is public, installing it needs them.
PACKAGES = [f"{SCOPE}/agent-{suffix}" for suffix, *_ in PLATFORMS.values()] + [f"{SCOPE}/agent"]
# The fields a staged version's id and version may come under in `npm stage list --json`.
ID_FIELDS = ("id", "stageId", "stage_id")


def npm(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["npm", *args], capture_output=True, text=True, check=False)  # noqa: S607 (npm on PATH)


def staged(package: str, version: str) -> list[str]:
    """The ids of the package's staged versions that are this release."""
    result = npm("stage", "list", package, "--json")
    if result.returncode != 0:
        sys.exit(f"npm stage list {package}: {result.stderr.strip()}")
    entries = json.loads(result.stdout or "[]")
    if isinstance(entries, dict):
        entries = entries.get("objects") or entries.get("stages") or list(entries.values())
    ids = []
    for entry in entries:
        found = next((str(entry[field]) for field in ID_FIELDS if field in entry), None)
        if found is None:
            sys.exit(f"npm stage list {package}: no id in {entry}")
        if entry.get("version", version) == version:
            ids.append(found)
    return ids


def approve(stage_id: str, code: str) -> tuple[bool, str]:
    result = npm("stage", "approve", stage_id, "--otp", code)
    return result.returncode == 0, (result.stderr or result.stdout).strip()


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    version = sys.argv[1] if "-" in sys.argv[1] else semver(sys.argv[1])
    pending = [(package, stage_id) for package in PACKAGES for stage_id in staged(package, version)]
    if not pending:
        sys.exit(f"nothing of {version} is staged")
    print(f"{version}: {len(pending)} staged versions")
    code = getpass.getpass("2FA code: ")
    for package, stage_id in pending:
        ok, output = approve(stage_id, code)
        if not ok and "otp" in output.lower():
            code = getpass.getpass(f"{package}: npm took that code already, a new one: ")
            ok, output = approve(stage_id, code)
        if not ok:
            sys.exit(f"{package}: {output}")
        print(f"  approved {package}@{version}")
    print(f"{version} is public")


if __name__ == "__main__":
    main()
