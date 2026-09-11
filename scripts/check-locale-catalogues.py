#!/usr/bin/env python3
"""Assert every locale ships the same message catalogue as English.

Each locale is a directory under frontend/messages holding one JSON file per
namespace. A key present in English but missing elsewhere would render as the
raw key; a placeholder that differs ({count} vs {n}) would throw at format
time. Both are caught here rather than by a user.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MESSAGES = ROOT / "frontend" / "messages"
LOCALES = ("en", "zh-Hans", "ja", "ko")
NAMESPACES = (
    "common", "settings", "shell", "tasks", "projects", "goals", "reviews", "agents", "runtimes",
    "issueDetail",
)
PLACEHOLDER = re.compile(r"\{\s*([A-Za-z_][A-Za-z0-9_]*)")


def flatten(value: object, prefix: str, out: dict[str, str], where: str) -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            flatten(child, f"{prefix}.{key}" if prefix else key, out, where)
    elif isinstance(value, str):
        if not value.strip():
            raise ValueError(f"{where}: {prefix} is empty")
        out[prefix] = value
    else:
        raise ValueError(f"{where}: {prefix} must be a string or an object")


def load(locale: str, namespace: str) -> dict[str, str]:
    path = MESSAGES / locale / f"{namespace}.json"
    if not path.is_file():
        raise ValueError(f"missing catalogue {path.relative_to(ROOT)}")
    out: dict[str, str] = {}
    flatten(json.loads(path.read_text(encoding="utf-8")), "", out, str(path.relative_to(ROOT)))
    return out


def main() -> int:
    problems: list[str] = []
    for namespace in NAMESPACES:
        try:
            english = load("en", namespace)
        except ValueError as error:
            problems.append(str(error))
            continue
        for locale in LOCALES[1:]:
            try:
                other = load(locale, namespace)
            except ValueError as error:
                problems.append(str(error))
                continue
            for key in sorted(english.keys() - other.keys()):
                problems.append(f"{locale}/{namespace}: missing {key}")
            for key in sorted(other.keys() - english.keys()):
                problems.append(f"{locale}/{namespace}: unexpected {key}")
            for key in sorted(english.keys() & other.keys()):
                want = set(PLACEHOLDER.findall(english[key]))
                got = set(PLACEHOLDER.findall(other[key]))
                if want != got:
                    problems.append(
                        f"{locale}/{namespace}: {key} placeholders {sorted(got)} != {sorted(want)}"
                    )
    for problem in problems:
        print(problem, file=sys.stderr)
    if problems:
        return 1
    print(f"locale catalogues agree: {len(LOCALES)} locales x {len(NAMESPACES)} namespaces")
    return 0


if __name__ == "__main__":
    sys.exit(main())
