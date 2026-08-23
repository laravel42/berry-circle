#!/usr/bin/env python3
"""Validate immutable deployment pins and their repository references."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
OPENFANG_PIN = ROOT / "deploy" / "openfang.pin.json"
MULTICA_PIN = ROOT / "deploy" / "multica.pin.json"
COMPOSE_FILE = ROOT / "docker-compose.yml"

EXPECTED_MULTICA_COMMIT = "8c9b7503a12ded3f28553da48b9851621f10be6b"
EXPECTED_MULTICA_REFERENCES = {
    "parityContract": "docs/parity/multica-web.md",
    "provenanceRecord": "docs/provenance/multica-server-reuse.md",
}
FULL_COMMIT = re.compile(r"^[0-9a-f]{40}$")
OPENFANG_COMPOSE_DEFAULT = re.compile(
    r"\$\{OPENFANG_COMMIT:-([0-9a-f]{40})\}"
)
OPENFANG_SHORT_COMPOSE_DEFAULT = re.compile(
    r"\$\{OPENFANG_COMMIT_SHORT:-([0-9a-f]{8})\}"
)


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


def check_openfang() -> None:
    pin = load_object(OPENFANG_PIN)
    commit = require_full_commit("OpenFang", pin.get("commit"))
    short_commit = pin.get("shortCommit")
    if short_commit != commit[:8]:
        raise ValueError("OpenFang shortCommit must equal the first eight commit characters")

    compose = COMPOSE_FILE.read_text(encoding="utf-8")
    defaults = OPENFANG_COMPOSE_DEFAULT.findall(compose)
    if defaults != [commit]:
        rendered = ", ".join(defaults) if defaults else "none"
        raise ValueError(
            "docker-compose.yml must contain exactly one OPENFANG_COMMIT default "
            f"matching deploy/openfang.pin.json (found: {rendered})"
        )

    short_defaults = OPENFANG_SHORT_COMPOSE_DEFAULT.findall(compose)
    if short_defaults != [short_commit]:
        rendered = ", ".join(short_defaults) if short_defaults else "none"
        raise ValueError(
            "docker-compose.yml must contain exactly one OPENFANG_COMMIT_SHORT default "
            f"matching deploy/openfang.pin.json (found: {rendered})"
        )

    contract = pin.get("contractVerifiedAgainst")
    if not isinstance(contract, str) or not (ROOT / contract).is_file():
        raise ValueError("OpenFang contractVerifiedAgainst must reference an existing file")


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
        check_openfang()
        check_multica()
    except (OSError, ValueError) as error:
        print(f"deployment pin check failed: {error}", file=sys.stderr)
        return 1

    print("Deployment pins are consistent.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
