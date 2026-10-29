# /// script
# requires-python = ">=3.11"
# ///
"""THIRD-PARTY-NOTICES: the licenses of the open source code inside the agent's binary, shipped in every wheel.

Three parts: the Rust crates it is compiled from (cargo about, about.toml and about.hbs), what every Rust program
links in (Rust's standard library, and musl's C library in the static Linux builds), and what the embedded console
is built from: ui/'s production dependencies, the build tools whose output lands in the bundle (BUNDLED) and the
shadcn/ui components copied into ui/ (VENDORED). Their licenses (MIT, Apache-2.0, BSD, OFL for the fonts…) ask
for their texts to go with the program, which embeds this file too: `tracepanel-agent licenses` and the console's
Licenses page show it.

    uv run scripts/notices.py            # write THIRD-PARTY-NOTICES
    uv run scripts/notices.py --check    # fail if it is out of date (CI)
    uv run scripts/notices.py --ui       # print the UI's part (scripts/ui.sh keeps it in ui-dist/NOTICES)

Needs cargo-about at CARGO_ABOUT (`cargo install --locked cargo-about@0.9.3 --features cli`), the version the
workflows install: another one reads the crates' license files differently, and CI's check would disagree. The UI's part comes from ui-dist/NOTICES,
written with the UI by scripts/ui.sh; `--ui` reads ui/ with its packages installed.
"""

import json
import subprocess
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "THIRD-PARTY-NOTICES"
UI = ROOT / "ui"
UI_NOTICES = ROOT / "ui-dist" / "NOTICES"
LINKED = ROOT / "scripts" / "licenses"
# devDependencies whose code is in the bundle all the same: Tailwind's CSS (preflight, utilities), tw-animate-css's
# keyframes, and the runtime helpers Vite and Rolldown add (the modulepreload polyfill, the chunk loader).
BUNDLED = ("tailwindcss", "tw-animate-css", "vite", "rolldown")
# Source copied into ui/ rather than installed: its directory holds the license it came with.
VENDORED = (("shadcn/ui components", UI / "packages" / "ui" / "src" / "components" / "ui", "MIT"),)
# The cargo-about the notices are written with, here and in CI (.github/workflows): 0.9.3 found license headers in
# more of ring's files than 0.9.2, so the same lockfile gave other notices.
CARGO_ABOUT = "0.9.3"
# The musl the Rust toolchain ships for its *-linux-musl targets, which link it in statically.
MUSL = "1.2.5"
LICENSE_FILES = ("LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "LICENSE-MIT", "OFL.txt", "license", "license.md")
RULE = "-" * 80
# For a package that declares MIT but ships no license file: the license's text, with its author from package.json.
MIT = """Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE."""
# Public domain dedications: nothing to reproduce.
NO_NOTICE = {"CC0-1.0", "Unlicense", "0BSD"}


def rust() -> str:
    version = subprocess.run(  # noqa: S603 (cargo, this workspace)
        ["cargo", "about", "--version"],  # noqa: S607
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.split()[-1]
    if version != CARGO_ABOUT:
        sys.exit(
            f"cargo-about {version}, the notices need {CARGO_ABOUT}: "
            f"cargo install --locked cargo-about@{CARGO_ABOUT} --features cli"
        )
    return subprocess.run(  # noqa: S603 (cargo, this workspace)
        ["cargo", "about", "generate", "--fail", "about.hbs"],  # noqa: S607
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def license_text(package: Path, license_id: str) -> str | None:
    for name in LICENSE_FILES:
        if (package / name).is_file():
            return (package / name).read_text(errors="replace").strip()
    if license_id in NO_NOTICE:
        return f"{license_id}: no notice required."
    if license_id == "MIT":
        manifest = json.loads((package / "package.json").read_text())
        author = manifest.get("author")
        author = author.get("name") if isinstance(author, dict) else author
        return f"Copyright (c) {author or 'its authors'}\n\n{MIT}"
    return None


def listed(*flags: str) -> list[tuple[str, str, str, Path]]:
    listing = subprocess.run(  # noqa: S603 (pnpm, ui/)
        # -r: every workspace package's dependencies (pnpm 12 lists only the root's without it, and it has none).
        ["pnpm", "licenses", "list", *flags, "--json", "-r"],  # noqa: S607
        cwd=UI,
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    return sorted(
        (package["name"], version, license_id, Path(path))
        for license_id, items in json.loads(listing).items()
        for package in items
        for version, path in zip(package["versions"], package["paths"], strict=False)
    )


def ui() -> str:
    production = listed("--prod")
    if not production:
        # An empty listing is a pnpm change, not a console without dependencies: never ship no notices silently.
        sys.exit("pnpm licenses listed no packages in ui/")
    bundled = [package for package in listed() if package[0] in BUNDLED]
    if sorted({package[0] for package in bundled}) != sorted(BUNDLED):
        sys.exit(f"not installed in ui/: {', '.join(sorted(set(BUNDLED) - {package[0] for package in bundled}))}")
    packages = sorted(set(production) | set(bundled))
    parts = []
    missing = []
    for name, version, license_id, path in packages:
        text = license_text(path, license_id)
        if text is None:
            missing.append(f"{name} {version}")
            continue
        parts.append(f"{RULE}\n{name} {version} ({license_id})\n\n{text}\n")
    for name, path, license_id in VENDORED:
        text = license_text(path, license_id)
        if text is None:
            missing.append(name)
            continue
        parts.append(f"{RULE}\n{name} ({license_id}), copied into {path.relative_to(ROOT)}\n\n{text}\n")
    if missing:
        sys.exit(f"no license file in: {', '.join(missing)}")
    return "\n".join(parts).strip()


def toolchain() -> str:
    """The Rust release the agent is built with (rust-toolchain.toml): its standard library is in the binary."""
    return tomllib.loads((ROOT / "rust-toolchain.toml").read_text())["toolchain"]["channel"]


def linked() -> str:
    rust = (LINKED / "rust-LICENSE-MIT").read_text().strip()
    musl = (LINKED / "musl-COPYRIGHT").read_text().strip()
    return (
        f"{RULE}\nThe Rust standard library {toolchain()} (std, core, alloc and what they depend on)"
        " (MIT OR Apache-2.0; under MIT here)\n\n"
        "In every build. Its full notices, the crates it is built from included, are in the toolchain's\n"
        "share/doc/rust/COPYRIGHT-library.html.\n\n"
        f"{rust}\n\n"
        f"{RULE}\nmusl {MUSL} (MIT)\n\nThe C library of the static Linux builds (the musllinux wheels, ARMv6), as the\n"
        f"Rust toolchain ships it.\n\n{musl}\n"
    )


def notices() -> str:
    return (
        "tracepanel-agent includes open source software. Their licenses and notices follow: first the Rust crates the\n"
        "program is compiled from, then the libraries it links in, then what the console it serves is built from.\n\n"
        f"{'=' * 80}\nRust crates\n{'=' * 80}\n{rust()}\n\n"
        f"{'=' * 80}\nLinked in\n{'=' * 80}\n{linked().strip()}\n\n"
        f"{'=' * 80}\nConsole (JavaScript, fonts)\n{'=' * 80}\n{UI_NOTICES.read_text().strip()}\n"
    )


def main() -> None:
    if "--ui" in sys.argv:
        print(ui())
        return
    text = notices()
    if "--check" in sys.argv:
        if not OUT.exists() or OUT.read_text() != text:
            sys.exit("THIRD-PARTY-NOTICES is out of date: run uv run scripts/notices.py and commit it")
        print("THIRD-PARTY-NOTICES: up to date")
        return
    OUT.write_text(text)
    print(f"THIRD-PARTY-NOTICES written ({len(text.splitlines())} lines)")


if __name__ == "__main__":
    main()
