# Berry

Berry is a self-hosted workspace where humans and AI coding agents plan, execute, and
review work together. Berry owns the browser-facing product, its durable state, and — since
[ADR-0008](docs/adr/0008-adk-agent-runtime.md) — agent execution itself: agents run
in-process on the Google Agent Development Kit rather than on a separate substrate.

| Path | What |
| --- | --- |
| `server-ts` | TypeScript product server, its migrations, and the agent runtime |
| `frontend` | Next.js App Router UI, vendored from the MIT Circle template |
| `docs` | Product brief, ADRs, API contract |
| `docker-compose.yml` | Server + PostgreSQL + MinIO local stack |
| `deploy/multica.pin.json` | Reuse provenance pin (engineering metadata only) |

Each workspace keeps its own validation commands; both are pnpm packages under
`pnpm-workspace.yaml`.

## What the server does and does not serve

The server is the reimplementation described in
[ADR-0009](docs/adr/0009-typescript-product-server.md), and it is not finished. It serves
identity, workspaces, boards, issues, comments, dependencies, reviews, goals, projects,
attachments-by-id, agents, and the realtime event streams.

It does **not** yet serve `/api/v1/runs`, `/workflows`, `/workflow-runs`, `/hooks`,
`/approvals`, `/plans`, `/conversations`, `/integrations`, `/inbox`, `/search`, `/views`,
`/catalogs`, `/runtime`, the multipart upload at `/issues/:ref/attachments`, or `/metrics`.
Those paths answer 404. `GET /api/v1/config` reports the capabilities this deployment
actually has, so the UI switches off what is missing rather than offering it.

`server-ts/SCOPE.md` records what was deliberately left out and why.

## Local Compose stack

`docker-compose.yml` starts the server plus its persistence dependencies:

| Service        | Image / source                    | Host bind         | Purpose                                          |
| -------------- | --------------------------------- | ----------------- | ------------------------------------------------ |
| `berry-api`    | built from `server-ts/Dockerfile` | `127.0.0.1:4000`  | Product API; migrates and seeds before startup   |
| `postgres`     | `postgres:16-alpine`              | `127.0.0.1:5432`  | Berry's durable product state (ADR-0002)         |
| `minio`        | `minio/minio`                     | `127.0.0.1:9000`  | S3-compatible artifact storage (ADR-0006)        |
| `minio-bucket` | `minio/mc`                        | —                 | Creates the artifact bucket once, then exits     |

All published ports are loopback-only by default. The server container runs with a
read-only root filesystem, dropped capabilities and `no-new-privileges`. Provider keys and
object-store credentials are passed only to `berry-api`, never under a `NEXT_PUBLIC_*`
name. `AUTH_ALLOW_PASSWORDLESS_LOGIN` defaults on for local Compose so the frontend can
auto-login as `prototype@berry.test` after the development seed runs.

## Boot the stack

Prerequisites: Docker Engine with the Compose plugin, and Python 3 for repository checks.

```sh
cp .env.example .env

# Set BERRY_OPENROUTER_API_KEY to enable agent execution. Without it the server
# reports agentExecution false and refuses run requests rather than accepting
# ones it cannot serve.

python3 scripts/check-deploy-pins.py
python3 scripts/check-compose-config.py
docker compose up -d --build

docker compose ps
```

The API waits for healthy PostgreSQL and for the artifact bucket, applies all forward-only
migrations under an advisory lock, seeds the development dataset, then starts. Migrations
and the seed are both idempotent, so this is the same on every boot.

### Verify the stack

```sh
curl http://127.0.0.1:4000/health
curl http://127.0.0.1:4000/ready
curl http://127.0.0.1:4000/api/v1/config

docker compose exec postgres pg_isready -U berry -d berry
```

`/metrics` answers 404 and `capabilities.metrics` is false: the observability port has not
landed. A healthy server does not imply the domains listed above as unserved are
implemented.

### Storage

Artifacts live in object storage (ADR-0006), and development runs the same S3 code path as
deployment rather than a local filesystem that behaves differently under presigning.
`S3_ENDPOINT` points at the MinIO service by default; leave it empty for real AWS.
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and the optional `AWS_SESSION_TOKEN` are
passed only to `berry-api` — empty values select the AWS workload credential chain. They
must never use a `NEXT_PUBLIC_*` name or enter the browser bundle.

Object storage is required for agent execution: an agent's files have nowhere to land
without it, and a run that produced work and dropped it is worse than one that never
started.

## Run workspaces on the host

```sh
pnpm install
```

### Product server

```sh
export DATABASE_URL=postgres://berry:berry@127.0.0.1:5432/berry?sslmode=disable

pnpm migrate:server
pnpm seed:server
pnpm dev:server
```

Verification:

```sh
pnpm typecheck:server
pnpm test:server
```

Database-backed tests are gated on `BERRY_TEST_DATABASE_URL` and skip without it, so the
default suite stays offline. See `server-ts/README.md` for how to prepare that database.

Note that a host PostgreSQL on 5432 shadows the container's published port, so
`127.0.0.1:5432` may not be the database Compose is using. Check before pointing anything
real at it.

### Frontend

The browser uses same-origin Berry paths by default. Next.js proxies `/api/*`, `/health`
and `/ready` to the server-only `BERRY_API_ORIGIN` (default `http://127.0.0.1:4000`).
`NEXT_PUBLIC_BERRY_API_URL` is only an explicit cross-origin development escape hatch;
never put a token or upstream URL in it. A frontend container on the Compose network can
target `http://berry-api:4000`.

```sh
cd frontend
cp .env.example .env.local
cd .. && pnpm dev:frontend
```

`pnpm dev:frontend` opens on `/{workspace}/runs` (default slug `berry`). Berry Dark is the
default theme; Berry Light and System are the other options. Visual language lives in
[the design system](docs/design-system.md). Empty queues and the run ledger are
intentional — do not restore Circle demo data or invent run records.

See [`frontend/README.md`](frontend/README.md) for the UI contract and env table.

### Models

Agents call OpenRouter. `BERRY_OPENROUTER_API_KEY` is the credential and
`BERRY_AGENT_DEFAULT_MODEL` is used when an agent row names no model of its own. The
`BERRY_`-prefixed name is read first on purpose: a stale `OPENROUTER_API_KEY` exported in
the launching shell outranks `.env` for Compose substitution, and has twice revived a
spent key.

## Operating the stack

```sh
docker compose logs -f berry-api    # migration, seed and API logs
docker compose restart berry-api    # restart one service
docker compose down                 # stop, keep volumes (data persists)
```

Do not use `docker compose down -v` as a routine reset: it irreversibly removes Berry's
PostgreSQL data and every stored artifact.

### PostgreSQL 16 to 17

The existing `berry-postgres` volume is PostgreSQL 16 data. Never change the image to 17
while reusing that volume. A future major-upgrade change must use a separate PostgreSQL 17
service and a new named volume, take and verify a `pg_dump`/restore (or reviewed
`pg_upgrade`) from 16, run Berry migrations and readiness checks against the copy, and
retain the 16 volume for rollback until cutover is accepted. The repository check currently
asserts the Compose image stays on `postgres:16-alpine`.

## Troubleshooting

- **`berry-api` never becomes ready** — inspect `docker compose logs berry-api`. The
  migrator runs first and exits non-zero on any ledger drift rather than migrating over it,
  so the failure is usually printed there before the server ever binds a port.
- **Agent runs are refused** — check `GET /api/v1/config`. `agentExecution` is true only
  when a model credential, object storage and `BERRY_INTERNAL_TOKEN` are all present.
- **Port already in use** — override `BERRY_API_PORT`, `POSTGRES_PORT`, `MINIO_PORT` or
  `MINIO_CONSOLE_PORT` in `.env`.

## Documentation

- [Product brief](docs/product-brief.md)
- [Design system](docs/design-system.md)
- [Architecture decisions](docs/adr/README.md)
- [API contract](docs/api/gateway-v1.md)
- [Coding playbook](docs/coding-playbook.md)
- [Release-readiness report template](docs/release-readiness-report-template.md)
- [Changelog](CHANGELOG.md) — notable changes per release ([process](docs/changelog-process.md))

## Licensing

All dependencies are permissively licensed (MIT / Apache-2.0); MIT notices are retained.
The "Linear" name and marks are not used as Berry product branding.
