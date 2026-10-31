# /// script
# requires-python = ">=3.11"
# ///
"""The agent on Maven Central, made from the npm packages of the same build: the binary of each is the one on PyPI.

One component, `dev.tracepanel:tracepanel-agent`, a POM with no jar of its own (packaging pom), and the binary of each
platform beside it, under the platform's npm name as its classifier: `tracepanel-agent-0.3.8-darwin-arm64.exe`, as
protoc is published. The Java SDK downloads the one it runs on, from Maven Central or a company's mirror of it. The
licenses go beside them, as the wheels and npm packages carry them: `tracepanel-agent-0.3.8-license.txt`, `-notice.txt`
and `-third-party-notices.txt` (each binary also prints them: `tracepanel-agent licenses`).

    uv run --no-project scripts/maven.py [--any-line-endings] VERSION NPM_PACKAGES OUT

NPM_PACKAGES holds the npm packages (.tgz) that scripts/npm.py made. OUT gets the bundle in the Maven repository
layout, with the checksums the Central Portal asks for. The signatures (.asc) are added after, by gpg, where the key
is. Python's standard library only.

The license files must be the same, byte for byte, in every package. Releases up to 0.10.0 have them with CRLF in the
Windows packages (git's checkout on the Windows runners, fixed by .gitattributes): --any-line-endings takes a CRLF
copy as the same text and publishes the LF one. The binaries are taken as they are either way.
"""

import hashlib
import json
import sys
import tarfile
from pathlib import Path
from xml.sax.saxutils import escape

GROUP = "dev.tracepanel"
ARTIFACT = "tracepanel-agent"
PREFIX = "@tracepanel/agent-"
PLATFORMS = 15
# The files every npm package of the agent holds (scripts/npm.py), by their classifier here.
LICENSES = {"LICENSE": "license", "NOTICE": "notice", "THIRD-PARTY-NOTICES": "third-party-notices"}

POM = """\
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>
  <groupId>{group}</groupId>
  <artifactId>{artifact}</artifactId>
  <version>{version}</version>
  <packaging>pom</packaging>
  <name>Tracepanel agent</name>
  <description>The Tracepanel agent: it keeps the traces, finds the issues and serves the console. One executable per
    platform, its classifier the platform: {classifiers}. Its licenses beside them, as txt: license, notice and
    third-party-notices.</description>
  <url>https://tracepanel.dev</url>
  <inceptionYear>2026</inceptionYear>
  <licenses>
    <license>
      <name>FSL-1.1-ALv2</name>
      <url>https://github.com/tracepanel/tracepanel/blob/{version}/LICENSE</url>
      <distribution>repo</distribution>
    </license>
  </licenses>
  <developers>
    <developer>
      <id>tracepanel</id>
      <name>Tracepanel</name>
      <url>https://tracepanel.dev</url>
    </developer>
  </developers>
  <scm>
    <url>https://github.com/tracepanel/tracepanel</url>
    <connection>scm:git:https://github.com/tracepanel/tracepanel.git</connection>
    <developerConnection>scm:git:ssh://git@github.com/tracepanel/tracepanel.git</developerConnection>
    <tag>{version}</tag>
  </scm>
</project>
"""


def binaries(packages: Path) -> dict[str, bytes]:
    """Each platform package's binary, by its platform; @tracepanel/agent itself holds the launcher and is left out."""
    found: dict[str, bytes] = {}
    for path in sorted(packages.glob("*.tgz")):
        with tarfile.open(path) as tgz:
            manifest = json.load(tgz.extractfile("package/package.json"))
            name = manifest["name"]
            if not name.startswith(PREFIX):
                continue
            files = [member for member in tgz.getmembers() if member.isfile() and member.name.startswith("package/bin/")]
            if len(files) != 1:
                sys.exit(f"{path.name}: {len(files)} files in bin/, expected the binary alone")
            found[name.removeprefix(PREFIX)] = tgz.extractfile(files[0]).read()
    return found


def licenses(packages: Path, any_line_endings: bool) -> dict[str, bytes]:
    """LICENSE, NOTICE and THIRD-PARTY-NOTICES, by their classifier: the same in every platform package, or no bundle.

    With any_line_endings, a copy that differs only by CRLF is the same, and the LF one is kept.
    """
    found: dict[str, bytes] = {}
    for path in sorted(packages.glob("*.tgz")):
        with tarfile.open(path) as tgz:
            for name, classifier in LICENSES.items():
                try:
                    member = tgz.extractfile(f"package/{name}")
                except KeyError:
                    sys.exit(f"{path.name}: no {name}")
                data = member.read()
                if any_line_endings:
                    data = data.replace(b"\r\n", b"\n")
                elif b"\r\n" in data:
                    sys.exit(f"{path.name}: its {name} has CRLF line endings")
                if found.setdefault(classifier, data) != data:
                    sys.exit(f"{path.name}: its {name} differs from another package's")
    return found


def write(path: Path, data: bytes) -> None:
    """The file, and the checksums the Central Portal asks for (md5 and sha1) and the stronger ones it takes."""
    path.write_bytes(data)
    for algorithm in ("md5", "sha1", "sha256", "sha512"):
        path.with_name(f"{path.name}.{algorithm}").write_text(hashlib.new(algorithm, data).hexdigest())


def main(version: str, packages: Path, out: Path, any_line_endings: bool = False) -> None:
    found = binaries(packages)
    if len(found) != PLATFORMS:
        sys.exit(f"{len(found)} platform packages in {packages}, expected {PLATFORMS}")
    directory = out.joinpath(*GROUP.split("."), ARTIFACT, version)
    directory.mkdir(parents=True, exist_ok=True)
    pom = POM.format(group=GROUP, artifact=ARTIFACT, version=escape(version), classifiers=", ".join(sorted(found)))
    write(directory / f"{ARTIFACT}-{version}.pom", pom.encode())
    for platform, binary in sorted(found.items()):
        write(directory / f"{ARTIFACT}-{version}-{platform}.exe", binary)
        print(f"{platform}: {len(binary):,} bytes, sha512 {hashlib.sha512(binary).hexdigest()[:16]}…")
    for classifier, text in sorted(licenses(packages, any_line_endings).items()):
        write(directory / f"{ARTIFACT}-{version}-{classifier}.txt", text)
        print(f"{classifier}: {len(text):,} bytes")


if __name__ == "__main__":
    arguments = sys.argv[1:]
    any_line_endings = "--any-line-endings" in arguments
    if any_line_endings:
        arguments.remove("--any-line-endings")
    if len(arguments) != 3:
        sys.exit(__doc__)
    main(arguments[0], Path(arguments[1]), Path(arguments[2]), any_line_endings)
