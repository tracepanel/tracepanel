"""The installed tracepanel-agent works: it receives a trace, finds its issue and serves both in the console's API.

Run where a wheel was installed (CI, on every platform); Python's standard library only. Talks to the agent as an SDK
that leaves the analysis to it (tracepanel-go): a hello line, then a length-prefixed JSON frame.
"""

import json
import shutil
import socket
import struct
import subprocess
import sys
import sysconfig
import tempfile
import time
import urllib.request
from pathlib import Path

WAIT_S = 15
BINARY = "tracepanel-agent" + (".exe" if sys.platform == "win32" else "")


def binary() -> str:
    installed = Path(sysconfig.get_path("scripts")) / BINARY
    found = str(installed) if installed.is_file() else shutil.which(BINARY)
    if found is None:
        sys.exit(f"{BINARY} is not installed")
    return found


def wait_for(path: Path, agent: subprocess.Popen[bytes]) -> str:
    deadline = time.monotonic() + WAIT_S
    while time.monotonic() < deadline:
        if path.exists() and (text := path.read_text().strip()):
            return text
        if agent.poll() is not None:
            sys.exit(f"the agent exited: {agent.communicate()[0].decode(errors='replace')}")
        time.sleep(0.1)
    sys.exit(f"no {path.name} after {WAIT_S} s")


def connect(address: str) -> socket.socket:
    if address.startswith("tcp:"):
        host, _, port = address.removeprefix("tcp:").rpartition(":")
        return socket.create_connection((host.strip("[]"), int(port)), timeout=WAIT_S)
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(WAIT_S)
    sock.connect(address.removeprefix("unix:"))
    return sock


def trace() -> dict[str, object]:
    """A request with an N+1: four lookups of one statement with different parameters."""
    start = time.time_ns() // 1000
    root = {"id": "01M4GB4T3ESQ49XVN62C0EXRT0", "parent_id": None, "kind": "http", "name": "GET /books"}
    queries = [
        {
            "id": f"01M4GB4T3ESQ49XVN62C0EXRT{n + 1}",
            "parent_id": root["id"],
            "kind": "sql",
            "name": "SELECT authors",
            "start": start,
            "duration": 100,
            "status": "ok",
            "attrs": {
                "db.fingerprint": "SELECT * FROM authors WHERE id = ?",
                "db.params_hash": str(n),
                "db.alias": "default",
                "code.origin": "app.go:54 in listBooks",
            },
        }
        for n in range(4)
    ]
    return {
        "id": "01M4GB4T3EAS5BY8E05Y1872S7",
        "kind": "http",
        "name": "GET /books",
        "start": start,
        "duration": 900,
        "status": "ok",
        "attrs": {"http.request.method": "GET", "http.route": "/books", "http.response.status_code": 200},
        "spans": [{**root, "start": start, "duration": 900, "status": "ok", "attrs": {}}, *queries],
        "logs": [],
        "errors": [],
        "links": [],
        "issues": [],
    }


def get(url: str) -> dict[str, object]:
    with urllib.request.urlopen(url, timeout=WAIT_S) as response:  # noqa: S310 (the agent on this machine)
        return json.loads(response.read())


def main() -> None:
    directory = Path(tempfile.mkdtemp()) / ".tracepanel"
    command = [binary(), "--dir", str(directory), "--serve", "127.0.0.1:0"]
    print(subprocess.run([binary(), "--version"], check=True, capture_output=True, text=True).stdout.strip())
    agent = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)  # noqa: S603
    try:
        address = wait_for(directory / "agent.addr", agent)
        console = wait_for(directory / "console.addr", agent)
        print(f"agent at {address}, console at {console}")

        with connect(address) as sock:
            sock.sendall(json.dumps({"protocol": 1, "max_traces": 100}).encode() + b"\n")
            answer = json.loads(sock.makefile("rb").readline())
            assert answer == {"ok": True}, answer
            frame = json.dumps([trace()]).encode()
            sock.sendall(struct.pack(">I", len(frame)) + frame)

        deadline = time.monotonic() + WAIT_S
        while not (listed := get(f"{console}api/traces")["traces"]) and time.monotonic() < deadline:
            time.sleep(0.2)
        assert [(row["name"], row["issues"]) for row in listed] == [("GET /books", 1)], listed
        issues = get(f"{console}api/issues")["issues"]
        assert [issue["kind"] for issue in issues] == ["n+1"], issues
        with urllib.request.urlopen(console, timeout=WAIT_S) as page:  # noqa: S310
            assert b"<html" in page.read().lower(), "no console page"
        print("received, analyzed and served: ok")
    finally:
        agent.terminate()
        agent.wait(timeout=WAIT_S)


if __name__ == "__main__":
    main()
