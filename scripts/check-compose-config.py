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
EXPECTED_SERVICES = {"berry-api", "postgres", "minio", "minio-bucket"}


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
    # Pinned rather than inherited: the point is to assert the defaults this
    # file ships, and a variable exported in the running shell would otherwise
    # substitute itself into the answer.
    env = os.environ.copy()
    env.update(
        {
            "APP_ENV": "development",
            "AUTH_ALLOW_PASSWORDLESS_LOGIN": "",
            "AWS_ACCESS_KEY_ID": "",
            "AWS_SECRET_ACCESS_KEY": "",
            "AWS_SESSION_TOKEN": "",
            "BERRY_AGENT_DEFAULT_MODEL": "",
            "BERRY_API_PORT": "4000",
            "BERRY_DATABASE_URL": (
                "postgres://berry:berry@postgres:5432/berry?sslmode=disable"
            ),
            "BERRY_INTERNAL_TOKEN": "",
            "BERRY_OPENROUTER_API_KEY": "",
            "MINIO_CONSOLE_PORT": "9001",
            "MINIO_PORT": "9000",
            "OPENROUTER_API_KEY": "",
            "POSTGRES_USER": "berry",
            "POSTGRES_PASSWORD": "berry",
            "POSTGRES_DB": "berry",
            "POSTGRES_PORT": "5432",
            "REALTIME_BUFFER": "",
            "S3_BUCKET": "",
            "S3_ENDPOINT": "",
            "S3_REGION": "",
            "S3_USE_PATH_STYLE": "",
            "SERVICE_NAME": "",
            "SESSION_TTL": "",
            "STORAGE_MAX_BYTES": "",
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

    # Weak development credentials: the API and the console must never be
    # reachable from outside this host.
    minio = object_value(services["minio"], "minio service")
    require_loopback_port(minio, "minio", 9000)
    require_loopback_port(minio, "minio", 9001)

    api = object_value(services["berry-api"], "berry-api service")
    build = object_value(api.get("build"), "berry-api build")
    if Path(str(build.get("context"))).resolve() != (ROOT / "server-ts").resolve():
        fail("berry-api build context must be server-ts/")
    if build.get("dockerfile") != "Dockerfile":
        fail("berry-api must build server-ts/Dockerfile")

    dependencies = object_value(api.get("depends_on"), "berry-api depends_on")
    postgres_dependency = object_value(
        dependencies.get("postgres"), "berry-api postgres dependency"
    )
    if postgres_dependency.get("condition") != "service_healthy":
        fail("berry-api must wait for healthy postgres")
    # The bucket is created by a job that exits, so healthy is not the state
    # to wait for — completion is.
    bucket_dependency = object_value(
        dependencies.get("minio-bucket"), "berry-api minio-bucket dependency"
    )
    if bucket_dependency.get("condition") != "service_completed_successfully":
        fail("berry-api must wait for the artifact bucket to be created")

    # Readiness must never race schema setup, so the migrator runs to
    # completion before the server binds a port.
    command = json.dumps(api.get("command"))
    if "src/migrate/index.ts" not in command or "src/index.ts" not in command:
        fail("berry-api must run migrations before starting the server")

    require_loopback_port(api, "berry-api", 4000)

    environment = object_value(api.get("environment"), "berry-api environment")
    expected_environment = {
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "BERRY_INTERNAL_TOKEN",
        "DATABASE_URL",
        "S3_BUCKET",
        "S3_USE_PATH_STYLE",
    }
    missing_environment = sorted(expected_environment.difference(environment))
    if missing_environment:
        fail(f"berry-api environment is missing: {', '.join(missing_environment)}")

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
    # databases, the frontend — rather than letting it spread by habit.
    # berry-api is where an agent's files are written and where attachments
    # are served from; minio is the store itself and reads them under its own
    # MINIO_ROOT_* names.
    s3_credentials = {"AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"}
    storage_services = {"berry-api"}
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

