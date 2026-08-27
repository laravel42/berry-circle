#!/usr/bin/env python3
"""Render Compose safely and assert Berry's deployment invariants."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
COMPOSE_FILE = ROOT / "docker-compose.yml"
EXPECTED_SERVICES = {"berry-api", "openfang", "postgres", "valkey"}


def fail(message: str) -> None:
    raise ValueError(message)


def object_value(value: object, name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        fail(f"{name} must be an object in rendered Compose config")
    return value


def require_loopback_port(service: dict[str, Any], name: str, port_number: int) -> None:
    ports = service.get("ports")
    if not isinstance(ports, list) or not any(
        isinstance(port, dict)
        and port.get("target") == port_number
        and str(port.get("published")) == str(port_number)
        and port.get("host_ip") == "127.0.0.1"
        for port in ports
    ):
        fail(f"{name} port {port_number} must be published on host loopback only")


def render_compose() -> dict[str, Any]:
    try:
        pin = json.loads(
            (ROOT / "deploy" / "openfang.pin.json").read_text(encoding="utf-8")
        )
        openfang_commit = pin["commit"]
        openfang_short_commit = pin["shortCommit"]
    except (OSError, KeyError, TypeError, json.JSONDecodeError) as error:
        raise RuntimeError(f"cannot read deploy/openfang.pin.json: {error}") from error

    if not isinstance(openfang_commit, str) or not isinstance(openfang_short_commit, str):
        raise RuntimeError("deploy/openfang.pin.json commit fields must be strings")

    env = os.environ.copy()
    env.update(
        {
            "ANTHROPIC_API_KEY": "",
            "AWS_ACCESS_KEY_ID": "",
            "AWS_SECRET_ACCESS_KEY": "",
            "AWS_SESSION_TOKEN": "",
            "BERRY_API_PORT": "4000",
            "BERRY_DATABASE_URL": (
                "postgres://berry:berry@postgres:5432/berry?sslmode=disable"
            ),
            "BERRY_VALKEY_URL": "redis://valkey:6379/0",
            "GROQ_API_KEY": "",
            "OLLAMA_BASE_URL": "",
            "OPENAI_API_KEY": "",
            "OPENFANG_COMMIT": openfang_commit,
            "OPENFANG_COMMIT_SHORT": openfang_short_commit,
            "OPENFANG_API_KEY": "compose-check-placeholder",
            "OPENFANG_PORT": "4200",
            "POSTGRES_USER": "berry",
            "POSTGRES_PASSWORD": "berry",
            "POSTGRES_DB": "berry",
            "POSTGRES_PORT": "5432",
            "REALTIME_NODE_ID": "",
            "REALTIME_READ_BLOCK": "5s",
            "REALTIME_RELAY_REQUIRED": "true",
            "REALTIME_STREAM_MAXLEN": "10000",
            "REALTIME_STREAM_TTL": "15m",
            "S3_BUCKET": "",
            "S3_ENDPOINT": "",
            "S3_REGION": "",
            "S3_USE_PATH_STYLE": "",
            "VALKEY_ENABLED": "true",
            "VALKEY_REQUIRED": "true",
            "VALKEY_PORT": "6379",
            "VLLM_API_KEY": "",
            "VLLM_BASE_URL": "",
        }
    )

    try:
        result = subprocess.run(
            [
                "docker",
                "compose",
                "--file",
                str(COMPOSE_FILE),
                "config",
                "--format",
                "json",
            ],
            cwd=ROOT,
            env=env,
            check=False,
            capture_output=True,
            text=True,
        )
    except FileNotFoundError as error:
        raise RuntimeError("Docker with the Compose plugin is required") from error

    if result.returncode != 0:
        detail = result.stderr.strip() or "docker compose config failed"
        raise RuntimeError(detail)

    try:
        rendered = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"Compose did not return valid JSON: {error}") from error
    return object_value(rendered, "Compose config")


def check_services(rendered: dict[str, Any]) -> None:
    services = object_value(rendered.get("services"), "services")
    missing = sorted(EXPECTED_SERVICES.difference(services))
    if missing:
        fail(f"Compose config is missing services: {', '.join(missing)}")

    postgres = object_value(services["postgres"], "postgres service")
    if postgres.get("image") != "postgres:16-alpine":
        fail("postgres must remain on postgres:16-alpine until a separate-volume upgrade")
    require_loopback_port(postgres, "postgres", 5432)

    openfang = object_value(services["openfang"], "openfang service")
    require_loopback_port(openfang, "openfang", 4200)

    valkey = object_value(services["valkey"], "valkey service")
    require_loopback_port(valkey, "valkey", 6379)

    api = object_value(services["berry-api"], "berry-api service")
    build = object_value(api.get("build"), "berry-api build")
    if Path(str(build.get("context"))).resolve() != (ROOT / "server").resolve():
        fail("berry-api build context must be server/")
    if build.get("dockerfile") != "Dockerfile":
        fail("berry-api must build server/Dockerfile")

    dependencies = object_value(api.get("depends_on"), "berry-api depends_on")
    for dependency in ("postgres", "valkey", "openfang"):
        config = object_value(dependencies.get(dependency), f"berry-api {dependency} dependency")
        if config.get("condition") != "service_healthy":
            fail(f"berry-api must wait for healthy {dependency}")

    command = json.dumps(api.get("command"))
    if "berry-migrate" not in command or "berry-api" not in command:
        fail("berry-api must run migrations before starting the API")

    require_loopback_port(api, "berry-api", 4000)

    environment = object_value(api.get("environment"), "berry-api environment")
    if "OPENFANG_API_KEY" not in environment:
        fail("berry-api must receive the OpenFang key server-side")
    expected_environment = {
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "REALTIME_NODE_ID",
        "REALTIME_READ_BLOCK",
        "REALTIME_RELAY_REQUIRED",
        "REALTIME_STREAM_MAXLEN",
        "REALTIME_STREAM_TTL",
        "S3_USE_PATH_STYLE",
    }
    missing_environment = sorted(expected_environment.difference(environment))
    if missing_environment:
        fail(f"berry-api environment is missing: {', '.join(missing_environment)}")
    for required_true in ("VALKEY_ENABLED", "VALKEY_REQUIRED", "REALTIME_RELAY_REQUIRED"):
        if environment.get(required_true) != "true":
            fail(f"berry-api must default {required_true}=true for multi-instance readiness")
    expected_realtime_defaults = {
        "REALTIME_NODE_ID": "",
        "REALTIME_STREAM_MAXLEN": "10000",
        "REALTIME_STREAM_TTL": "15m",
        "REALTIME_READ_BLOCK": "5s",
    }
    for key, expected in expected_realtime_defaults.items():
        if environment.get(key) != expected:
            fail(f"berry-api must default {key}={expected!r}")
    leaked = sorted(
        f"{service_name}.{key}"
        for service_name, service_value in services.items()
        for key in object_value(service_value, f"{service_name} service").get("environment", {})
        if key.startswith("NEXT_PUBLIC_")
    )
    if leaked:
        fail(f"Compose services must not receive browser-public env values: {', '.join(leaked)}")

    # Object-store credentials belong only to the services that read or write
    # objects. Naming them keeps the credential off everything else — the
    # frontend, the runtime, the databases — rather than letting it spread by
    # habit. berry-api serves uploads, berry-worker promotes what a run
    # produced, and berry-api-ts is where an ADK agent's files are written.
    s3_credentials = {"AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"}
    storage_services = {"berry-api", "berry-worker", "berry-api-ts"}
    for service_name, service_value in services.items():
        if service_name in storage_services:
            continue
        service = object_value(service_value, f"{service_name} service")
        service_environment = service.get("environment", {})
        if isinstance(service_environment, dict) and s3_credentials.intersection(
            service_environment
        ):
            fail(f"S3 credentials must not be passed to {service_name}")

    healthcheck = object_value(api.get("healthcheck"), "berry-api healthcheck")
    if "/ready" not in json.dumps(healthcheck.get("test")):
        fail("berry-api healthcheck must probe readiness")


def main() -> int:
    try:
        check_services(render_compose())
    except (RuntimeError, ValueError) as error:
        print(f"compose config check failed: {error}", file=sys.stderr)
        return 1

    print("Compose config is valid and deployment invariants hold.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
