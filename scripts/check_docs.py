#!/usr/bin/env python3
"""Validate local Markdown links in tracked repository documentation."""

from __future__ import annotations

import re
import subprocess
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
LINK_RE = re.compile(r"!?(?:\[[^\]]*\])\(([^)]+)\)")


def tracked_markdown() -> list[Path]:
    output = subprocess.check_output(
        ["git", "-C", str(ROOT), "ls-files", "*.md"],
        text=True,
    )
    return [ROOT / line for line in output.splitlines() if line]


def local_target(raw: str) -> str | None:
    value = raw.strip()
    if not value or value.startswith("#"):
        return None
    if value.startswith("<") and ">" in value:
        value = value[1:value.index(">")]
    else:
        value = value.split(maxsplit=1)[0]
    parsed = urlsplit(value)
    if parsed.scheme or parsed.netloc:
        return None
    return unquote(parsed.path) or None

def main() -> int:
    failures: list[str] = []
    for markdown in tracked_markdown():
        text = markdown.read_text(encoding="utf-8")
        for match in LINK_RE.finditer(text):
            target = local_target(match.group(1))
            if target is None:
                continue
            candidate = (
                ROOT / target.lstrip("/")
                if target.startswith("/")
                else markdown.parent / target
            ).resolve()
            try:
                candidate.relative_to(ROOT)
            except ValueError:
                failures.append(f"{markdown.relative_to(ROOT)}: link escapes repository: {target}")
                continue
            if not candidate.exists():
                failures.append(f"{markdown.relative_to(ROOT)}: missing local target: {target}")

    if failures:
        print("\n".join(failures))
        return 1

    print(f"documentation links: OK ({len(tracked_markdown())} tracked Markdown files)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
