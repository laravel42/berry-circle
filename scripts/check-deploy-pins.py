#!/usr/bin/env python3
"""Validate immutable deployment pins and their repository references."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
MULTICA_PIN = ROOT / "deploy" / "multica.pin.json"

EXPECTED_MULTICA_COMMIT = "8c9b7503a12ded3f28553da48b9851621f10be6b"
EXPECTED_MULTICA_REFERENCES = {
    "parityContract": "docs/parity/multica-web.md",
    "provenanceRecord": "docs/provenance/multica-server-reuse.md",
}
FULL_COMMIT = re.compile(r"^[0-9a-f]{40}$")


def load_object(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"{path.relative_to(ROOT)} is not valid JSON: {error}") from error

    if not isinstance(value, dict):
        raise ValueError(f"{path.relative_to(ROOT)} must contain a JSON object")
    return value


def require_full_commit(pin_name: str, value: object) -> str:
    if not isinstance(value, str) or not FULL_COMMIT.fullmatch(value):
        raise ValueError(f"{pin_name} commit must be a full lowercase 40-character SHA")
    return value


def check_multica() -> None:
    pin = load_object(MULTICA_PIN)
    commit = require_full_commit("Multica", pin.get("commit"))
    if commit != EXPECTED_MULTICA_COMMIT:
        raise ValueError(
            "deploy/multica.pin.json does not match the approved Multica baseline"
        )
    if pin.get("shortCommit") != commit[:8]:
        raise ValueError("Multica shortCommit must equal the first eight commit characters")

    for field, expected_path in EXPECTED_MULTICA_REFERENCES.items():
        if pin.get(field) != expected_path:
            raise ValueError(f"Multica {field} must equal {expected_path}")

        document = ROOT / expected_path
        if not document.is_file():
            raise ValueError(f"Multica {field} does not reference an existing file")
        if commit not in document.read_text(encoding="utf-8"):
            raise ValueError(f"{expected_path} must record the full approved Multica commit")


def main() -> int:
    try:
        check_multica()
    except (OSError, ValueError) as error:
        print(f"deployment pin check failed: {error}", file=sys.stderr)
        return 1

    print("Deployment pins are consistent.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
