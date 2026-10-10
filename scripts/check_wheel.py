"""A wheel of the agent carries nothing of the build: no paths of the machine that built it, no source maps.

Usage: python scripts/check_wheel.py dist/*.whl (CI, after building each wheel).
"""

import re
import sys
import zipfile

# Absolute paths of a build machine: home directories, CI workspaces, cargo homes (Unix and Windows).
LEAKS = re.compile(rb"/home/[^/\0]+/|/Users/[^/\0]+/|/root/\.cargo|[A-Za-z]:\\\\?Users\\\\|runneradmin|sourceMappingURL")


def check(path: str) -> list[str]:
    found = []
    with zipfile.ZipFile(path) as wheel:
        for name in wheel.namelist():
            if name.endswith(".map"):
                found.append(f"{name}: a source map")
            for match in sorted(set(LEAKS.findall(wheel.read(name))))[:5]:
                found.append(f"{name}: {match.decode(errors='replace')}")
    return found


def main() -> None:
    failed = False
    for path in sys.argv[1:]:
        problems = check(path)
        print(f"{path}: {'ok' if not problems else 'LEAKS'}")
        for problem in problems:
            print(f"  {problem}")
        failed = failed or bool(problems)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
