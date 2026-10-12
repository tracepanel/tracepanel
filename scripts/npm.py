# /// script
# requires-python = ">=3.11"
# ///
"""The agent's npm packages, made from the wheels of the same build: the binary in each is the one on PyPI.

One package per platform, `@tracepanel/agent-<platform>`, holds the binary, with `os`, `cpu` and `libc` so npm
installs only the one that fits. `@tracepanel/agent` lists them all as optional dependencies, runs the installed one
as `tracepanel-agent`, and tells SDKs where it is (`binaryPath()`).

    uv run --no-project scripts/npm.py WHEELS OUT
    uv run --no-project scripts/npm.py --download 0.0.1a1 WHEELS   # a released version's wheels, from PyPI

WHEELS holds one directory per wheel, `wheel-<rust target>/`: the build's artifacts (actions/download-artifact without
merging), or a release's wheels from PyPI. OUT gets one directory per package, ready for `npm pack` or
`npm publish`. The version is the wheels': 0.0.1a1 on PyPI is 0.0.1-alpha.1 on npm. Python's standard library only.
"""

import json
import re
import shutil
import stat
import sys
import urllib.request
import zipfile
from pathlib import Path

SCOPE = "@tracepanel"
LICENSE = "FSL-1.1-ALv2"
REPOSITORY = "https://github.com/tracepanel/tracepanel"
LICENSE_FILES = ("LICENSE", "NOTICE", "THIRD-PARTY-NOTICES")

# The wheel's Rust target: the package's platform, and npm's os, cpu and libc for it (None: any libc).
# 32-bit ARM gets one package, the static armv6 build: it runs on armv6 (Raspberry Pi 1 and Zero) and armv7 alike,
# and npm's `cpu` can't tell the two apart. The armv7 wheels stay on PyPI only.
PLATFORMS: dict[str, tuple[str, str, str, str | None]] = {
    "x86_64-unknown-linux-gnu": ("linux-x64-gnu", "linux", "x64", "glibc"),
    "aarch64-unknown-linux-gnu": ("linux-arm64-gnu", "linux", "arm64", "glibc"),
    "i686-unknown-linux-gnu": ("linux-ia32-gnu", "linux", "ia32", "glibc"),
    "powerpc64le-unknown-linux-gnu": ("linux-ppc64-gnu", "linux", "ppc64", "glibc"),
    "s390x-unknown-linux-gnu": ("linux-s390x-gnu", "linux", "s390x", "glibc"),
    "riscv64gc-unknown-linux-gnu": ("linux-riscv64-gnu", "linux", "riscv64", "glibc"),
    "x86_64-unknown-linux-musl": ("linux-x64-musl", "linux", "x64", "musl"),
    "aarch64-unknown-linux-musl": ("linux-arm64-musl", "linux", "arm64", "musl"),
    "i686-unknown-linux-musl": ("linux-ia32-musl", "linux", "ia32", "musl"),
    "arm-unknown-linux-musleabihf": ("linux-arm", "linux", "arm", None),
    "aarch64-apple-darwin": ("darwin-arm64", "darwin", "arm64", None),
    "x86_64-apple-darwin": ("darwin-x64", "darwin", "x64", None),
    "x86_64-pc-windows-msvc": ("win32-x64", "win32", "x64", None),
    "i686-pc-windows-msvc": ("win32-ia32", "win32", "ia32", None),
    "aarch64-pc-windows-msvc": ("win32-arm64", "win32", "arm64", None),
}

# Finds the installed platform package's binary. Linux has a glibc and a musl package for most CPUs: Node's report
# names the glibc it runs on, and says nothing on musl.
INDEX_JS = """\
"use strict";

const path = require("node:path");

function libc() {
  if (process.platform !== "linux") return "";
  const header = process.report && process.report.getReport().header;
  return header && header.glibcVersionRuntime ? "gnu" : "musl";
}

/** The platform package npm installed for this machine. */
function platformPackage() {
  const { platform, arch } = process;
  if (platform === "linux" && arch === "arm") return "@tracepanel/agent-linux-arm";
  if (platform === "linux") return `@tracepanel/agent-linux-${arch}-${libc()}`;
  return `@tracepanel/agent-${platform}-${arch}`;
}

/** The path of the tracepanel-agent binary: TRACEPANEL_AGENT_BIN, or the one npm installed. */
function binaryPath() {
  if (process.env.TRACEPANEL_AGENT_BIN) return process.env.TRACEPANEL_AGENT_BIN;
  const name = `tracepanel-agent${process.platform === "win32" ? ".exe" : ""}`;
  const pkg = platformPackage();
  try {
    return require.resolve(`${pkg}/bin/${name}`);
  } catch {
    throw new Error(
      `tracepanel-agent: ${pkg} is not installed. It may have been left out (npm --omit=optional), or there is ` +
        "no build for this platform: set TRACEPANEL_AGENT_BIN to an agent built for it.",
    );
  }
}

module.exports = { binaryPath, platformPackage };
"""

INDEX_D_TS = """\
/** The path of the tracepanel-agent binary: TRACEPANEL_AGENT_BIN, or the one npm installed for this platform. */
export function binaryPath(): string;
/** The name of the platform package npm installs for this machine, such as `@tracepanel/agent-darwin-arm64`. */
export function platformPackage(): string;
"""

# `tracepanel-agent` on the command line: the binary, with the arguments, the terminal and the exit status passed on.
BIN_JS = """\
#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");
const { binaryPath } = require("../index.js");

let binary;
try {
  binary = binaryPath();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
const result = spawnSync(binary, process.argv.slice(2), { stdio: "inherit" });
if (result.error) {
  console.error(`tracepanel-agent: ${result.error.message}`);
  process.exit(1);
}
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);
"""

README = """\
# @tracepanel/agent

The agent of [Tracepanel](https://github.com/tracepanel/tracepanel). It receives your app's traces, finds N+1
queries, duplicate and slow SQL, long transactions and errors, keeps everything in your project's `.tracepanel/`
directory, and serves the panel and the console.

You don't install it yourself: the Tracepanel SDKs bring it, and the first traced request starts it. npm installs
only the build for your platform, from the `@tracepanel/agent-<platform>` packages. To run the agent by hand, with
the console on http://127.0.0.1:8765/:

```bash
npx @tracepanel/agent --serve 127.0.0.1:8765
```

SDKs find the binary with `require("@tracepanel/agent").binaryPath()`. `TRACEPANEL_AGENT_BIN` points them at
another build.

The agent is free to use on your projects, at work or on your own. It is fair source, under the Functional Source
License (FSL-1.1-ALv2). Use it, change it and share your changes. The one thing it reserves is offering Tracepanel
itself as a commercial product or hosted service. Each version becomes Apache License 2.0 two years after its
release.
"""


# A wheel's platform tag: the Rust target it was built for. Linux glibc wheels are tagged with the oldest glibc they
# run on, which changes over releases (aarch64 went from manylinux_2_17 to manylinux_2_28): matched by CPU only.
WHEEL_TAGS = [
    (r"manylinux_\d+_\d+_x86_64", "x86_64-unknown-linux-gnu"),
    (r"manylinux_\d+_\d+_aarch64", "aarch64-unknown-linux-gnu"),
    (r"manylinux_\d+_\d+_i686", "i686-unknown-linux-gnu"),
    (r"manylinux_\d+_\d+_ppc64le", "powerpc64le-unknown-linux-gnu"),
    (r"manylinux_\d+_\d+_s390x", "s390x-unknown-linux-gnu"),
    (r"manylinux_\d+_\d+_riscv64", "riscv64gc-unknown-linux-gnu"),
    (r"manylinux_\d+_\d+_armv7l", "armv7-unknown-linux-gnueabihf"),
    (r"musllinux_\d+_\d+_x86_64", "x86_64-unknown-linux-musl"),
    (r"musllinux_\d+_\d+_aarch64", "aarch64-unknown-linux-musl"),
    (r"musllinux_\d+_\d+_i686", "i686-unknown-linux-musl"),
    (r"musllinux_\d+_\d+_armv7l", "armv7-unknown-linux-musleabihf"),
    (r"linux_armv6l", "arm-unknown-linux-musleabihf"),
    (r"macosx_\d+_\d+_arm64", "aarch64-apple-darwin"),
    (r"macosx_\d+_\d+_x86_64", "x86_64-apple-darwin"),
    (r"win_amd64", "x86_64-pc-windows-msvc"),
    (r"win32", "i686-pc-windows-msvc"),
    (r"win_arm64", "aarch64-pc-windows-msvc"),
]


def semver(version: str) -> str:
    """A PEP 440 version as npm writes it: 0.0.1a1 is 0.0.1-alpha.1, as in Cargo.toml."""
    match = re.fullmatch(r"(\d+\.\d+\.\d+)(?:(a|b|rc)(\d+))?", version)
    if match is None:
        sys.exit(f"{version}: not a version this script knows how to write for npm")
    release, kind, number = match.groups()
    names = {"a": "alpha", "b": "beta", "rc": "rc"}
    return f"{release}-{names[kind]}.{number}" if kind else release


def wheel_target(name: str) -> str | None:
    """The Rust target of a wheel, from its platform tags (`manylinux_2_17_x86_64.manylinux2014_x86_64`: two)."""
    if not name.endswith(".whl"):
        return None
    tags = name.removesuffix(".whl").rsplit("-", 1)[-1].split(".")
    return next((target for pattern, target in WHEEL_TAGS for tag in tags if re.fullmatch(pattern, tag)), None)


def download(version: str, wheels: Path) -> None:
    """A released version's wheels from PyPI, one directory per Rust target, as the build's artifacts are laid out."""
    with urllib.request.urlopen(f"https://pypi.org/pypi/tracepanel-agent/{version}/json", timeout=30) as response:
        files = json.loads(response.read())["urls"]
    for file in files:
        name = file["filename"]
        target = wheel_target(name)
        if target is None:
            continue
        directory = wheels / f"wheel-{target}"
        directory.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(file["url"], timeout=120) as response:
            (directory / name).write_bytes(response.read())
    print(f"{version}: {len(list(wheels.glob('wheel-*')))} wheels from PyPI in {wheels}")


def common(name: str, description: str, version: str) -> dict[str, object]:
    return {
        "name": name,
        "version": version,
        "description": description,
        "license": LICENSE,
        "homepage": REPOSITORY,
        "repository": {"type": "git", "url": f"git+{REPOSITORY}.git"},
    }


def write_json(path: Path, data: dict[str, object]) -> None:
    path.write_text(json.dumps(data, indent=2) + "\n")


def extract(wheel: Path, out: Path) -> None:
    """The binary into out/bin, executable, and the wheel's license files into out."""
    with zipfile.ZipFile(wheel) as archive:
        for member in archive.namelist():
            name = member.rsplit("/", 1)[-1]
            if ".data/scripts/tracepanel-agent" in member:
                target = out / "bin" / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(archive.read(member))
                target.chmod(target.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
            elif "/licenses/" in member and name in LICENSE_FILES:
                (out / name).write_bytes(archive.read(member))
    if not (out / "bin").is_dir():
        sys.exit(f"{wheel.name}: no tracepanel-agent binary in it")


def platform_package(target: str, wheel: Path, out: Path, version: str) -> str:
    suffix, os_name, cpu, libc = PLATFORMS[target]
    name = f"{SCOPE}/agent-{suffix}"
    directory = out / f"agent-{suffix}"
    directory.mkdir(parents=True)
    extract(wheel, directory)
    data = common(name, f"The tracepanel-agent binary for {suffix}. Installed by @tracepanel/agent.", version)
    data |= {"os": [os_name], "cpu": [cpu], "files": ["bin", *LICENSE_FILES], "preferUnplugged": True}
    if libc:
        data["libc"] = [libc]
    write_json(directory / "package.json", data)
    return name


def main_package(names: list[str], licenses_from: Path, out: Path, version: str) -> None:
    directory = out / "agent"
    (directory / "bin").mkdir(parents=True)
    (directory / "index.js").write_text(INDEX_JS)
    (directory / "index.d.ts").write_text(INDEX_D_TS)
    launcher = directory / "bin" / "tracepanel-agent.js"
    launcher.write_text(BIN_JS)
    launcher.chmod(0o755)
    (directory / "README.md").write_text(README)
    for name in LICENSE_FILES:
        shutil.copy(licenses_from / name, directory / name)
    data = common(
        f"{SCOPE}/agent",
        "The Tracepanel agent: keeps your app's traces and logs, finds N+1 queries and other issues, serves the "
        "local console",
        version,
    )
    data |= {
        "main": "index.js",
        "types": "index.d.ts",
        "bin": {"tracepanel-agent": "bin/tracepanel-agent.js"},
        "files": ["index.js", "index.d.ts", "bin", "README.md", *LICENSE_FILES],
        "engines": {"node": ">=18"},
        "optionalDependencies": dict.fromkeys(sorted(names), version),
    }
    write_json(directory / "package.json", data)


def wheel_version(wheel: Path) -> str:
    """The version in a wheel's name: tracepanel_agent-0.0.1a1-py3-none-....whl."""
    return wheel.name.split("-")[1]


def main() -> None:
    if sys.argv[1] == "--download":
        download(sys.argv[2], Path(sys.argv[3]))
        return
    wheels, out = Path(sys.argv[1]), Path(sys.argv[2])
    if out.exists():
        shutil.rmtree(out)
    found = {}
    for target in PLATFORMS:
        matches = sorted((wheels / f"wheel-{target}").glob("*.whl"))
        if len(matches) != 1:
            sys.exit(f"wheel-{target}: expected one wheel, found {len(matches)}")
        found[target] = matches[0]
    versions = {wheel_version(wheel) for wheel in found.values()}
    if len(versions) != 1:
        sys.exit(f"the wheels are of different versions: {sorted(versions)}")
    version = semver(versions.pop())
    names = [platform_package(target, wheel, out, version) for target, wheel in found.items()]
    main_package(names, out / f"agent-{PLATFORMS['x86_64-unknown-linux-gnu'][0]}", out, version)
    print(f"{len(names) + 1} npm packages, version {version}, in {out}")


if __name__ == "__main__":
    main()
