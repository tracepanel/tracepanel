"""Lint the documentation: its Python, and the habits its prose falls into.

The pages are the Markdown files a reader meets: the README, the contributing
and security notes, the package's page on PyPI and the schema's notes. Ruff
reads Python, not Markdown, so their Python blocks go to it one at a time,
named after the page and line they come from. A block is an excerpt, so only
formatting is checked.

The prose checks are the mechanical half of the style (the `docs` skill): the
turns of phrase that crept in often enough to be worth a rule. The rest is
judgement, and belongs to review. Comments in the Rust and Python sources answer
to the same rules, without the width and the semicolon.

    uv run --no-project --with ruff scripts/lint_docs.py
"""

from __future__ import annotations

import ast
import io
import re
import subprocess
import sys
import tokenize
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PAGES = ("README.md", "CONTRIBUTING.md", "SECURITY.md", "PYPI.md", "CHANGELOG.md", "schema/README.md")
BLOCK = re.compile(r"^```python\n(.*?)^```", re.MULTILINE | re.DOTALL)
WIDTH = 80

WORDS = (
    ("—", "an em-dash: use a full stop, a comma or a colon"),
    (r"\b(simply|just|obviously|of course|merely)\b", "a filler word"),
    (
        r"\b(easy|easily|trivial|trivially|straightforward|painless|seamless|seamlessly|powerful|blazing|effortless)\b",
        "a word that sells or tells the reader their trouble is small",
    ),
    (r"\b(is|are|was|were) what\b", "a cleft: say what does what"),
    (r"\b(we|our|us|let's)\b", "the first person: the docs speak of Tracepanel"),
)
PROSE = (
    *WORDS,
    (r"(?<!!)!(?!!|\[)", "an exclamation mark"),
    (";", "a semicolon: write two sentences"),
    (
        r"\b(end(s|ed)? up|spin(s|ning)? up|kick(s|ed)? off|reach(es|ed)? out|dive(s)? into)\b",
        "a phrasal verb: use the single plain verb",
    ),
)


def blocks(page: Path) -> list[tuple[int, str]]:
    """Return the Python blocks of a page, with the line each starts on."""
    text = page.read_text()
    return [(text[: found.start()].count("\n") + 2, found.group(1)) for found in BLOCK.finditer(text)]


def check_block(page: Path, line: int, source: str) -> str | None:
    """Return what ruff says about one block's formatting, if anything."""
    name = f"{page.name}:{line}.py"
    result = subprocess.run(  # noqa: S603 (ruff, on this repository's pages)
        ["ruff", "format", "--check", "--line-length", "120", "--stdin-filename", name, "-"],  # noqa: S607
        input=source,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        return f"{page.relative_to(ROOT)}:{line}  {result.stderr.strip() or 'would be reformatted'}"
    return None


def prose(page: Path) -> list[str]:
    """Return what the prose of a page does that the style rules out."""
    text = re.sub(r"```.*?```", lambda found: "\n" * found.group(0).count("\n"), page.read_text(), flags=re.DOTALL)
    found = []
    for number, line in enumerate(text.splitlines(), 1):
        where = f"{page.relative_to(ROOT)}:{number}"
        if line.lstrip().startswith(("|", ">")):
            continue
        spoken = re.sub(r"`[^`]*`", "", line)
        spoken = re.sub(r"!?\[[^\]]*\]\([^)]*\)", "", spoken)
        spoken = re.sub(r"https?://\S+", "", spoken)
        for pattern, said in PROSE:
            if re.search(pattern, spoken, re.IGNORECASE):
                found.append(f"{where}  {said}")
        if len(line) > WIDTH and "](http" not in line:
            found.append(f"{where}  {len(line)} columns: the prose wraps at {WIDTH}")
    return found


def comments(path: Path) -> list[tuple[int, str]]:
    """Return the prose of a source file: Rust's comments, Python's docstrings and comments."""
    text = path.read_text()
    if path.suffix == ".rs":
        return [
            (number, found.group(1))
            for number, line in enumerate(text.splitlines(), 1)
            if (found := re.match(r"\s*//[/!]?\s?(.*)", line))
        ]
    said = []
    for node in ast.walk(ast.parse(text)):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            written = ast.get_docstring(node, clean=True)
            if written:
                start = 1 if isinstance(node, ast.Module) else node.lineno
                said += [(start + number, line) for number, line in enumerate(written.splitlines())]
    said += [
        (token.start[0], token.string.lstrip("# "))
        for token in tokenize.generate_tokens(io.StringIO(text).readline)
        if token.type == tokenize.COMMENT
    ]
    return said


def source(path: Path) -> list[str]:
    """Return what the comments of a source file do that the style rules out."""
    found = []
    for number, line in comments(path):
        spoken = re.sub(r"`[^`]*`", "", line).strip()
        if not spoken or spoken.startswith(("noqa", "type:", "SAFETY:")):
            continue
        for pattern, said in WORDS:
            if re.search(pattern, spoken, re.IGNORECASE):
                found.append(f"{path.relative_to(ROOT)}:{number}  {said}")
    return found


def main() -> int:
    pages = [ROOT / page for page in PAGES if (ROOT / page).exists()]
    problems = [problem for page in pages for line, code in blocks(page) if (problem := check_block(page, line, code))]
    problems += [problem for page in pages for problem in prose(page)]
    sources = [*sorted((ROOT / "crates").rglob("*.rs")), *sorted((ROOT / "scripts").glob("*.py"))]
    problems += [problem for path in sources for problem in source(path)]
    for problem in problems:
        print(problem)
    print(f"\n{len(problems)} places need attention")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
