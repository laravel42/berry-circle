# Berry

Berry is a self-hosted workspace where humans and AI coding agents plan, execute, and
review work together. Berry owns the browser-facing product and durable product state;
[OpenFang](https://github.com/RightNow-AI/openfang) remains the pinned execution
substrate. Berry does **not** rebuild providers, agent execution, or sandboxes.

The repository temporarily carries three independently tooled workspaces during the Go
server migration:

| Path | What |
| --- | --- |
| `server` | Go product/control-plane server selected by ADR-0004 |
| `apps/gateway` | Bun + Hono compatibility oracle, run on the host during migration |
| `frontend` | Next.js App Router UI, vendored from the MIT Circle template |
| `docs` | Product brief, ADRs, API contract, OpenFang integration spec |
| `docker-compose.yml` | Go API + OpenFang + PostgreSQL + Valkey local stack |
| `deploy/openfang.pin.json` | Machine-readable OpenFang commit pin (ADR-0003) |
| `deploy/sqlc-artifacts.lock.json` | Integrity lock for policy-gated database artifacts |

Each workspace keeps its own formatter, dependency graph, and validation commands. The Go
foundation currently exposes operational endpoints and shared platform seams; domain
handlers land in later vertical slices. The Bun gateway remains executable compatibility
evidence, not a second authoritative writer.

## Local Compose stack

`docker-compose.yml` starts one Berry writer plus its execution and persistence
dependencies:

| Service     | Image / source                      | Host bind        | Purpose                                            |
| ----------- | ----------------------------------- | ---------------- | -------------------------------------------------- |
| `berry-api` | built from `server/Dockerfile`      | `127.0.0.1:4000` | Go product API; migrates and seeds before startup  |
| `openfang`  | built from pinned commit `acf2587e` | `127.0.0.1:4200` | Agent kernel + REST/WS/SSE + OpenAI-compatible API |
| `postgres`  | `postgres:16-alpine`                | `127.0.0.1:5432` | Berry's durable product state (ADR-0002)           |
| `valkey`    | `valkey/valkey:8-alpine`            | `127.0.0.1:6379` | Shared cache + ephemeral coordination (ADR-0002)   |

OpenFang keeps its own state in a SQLite database on the `openfang-data` volume; it does
**not** use the Berry Postgres or Valkey instances. Postgres and Valkey are Berry's own
backing services. Uploaded local objects use the separate `berry-uploads` volume.

All published ports are loopback-only by default. The Go container runs as a non-root user
with a read-only root filesystem and dropped capabilities; only its uploads volume is
writable. `OPENFANG_API_KEY` and provider keys are passed only to server-side containers.
`AUTH_ALLOW_PASSWORDLESS_LOGIN` defaults on for local Compose so the frontend can
auto-login as `prototype@berry.test` after the development seed runs.

### The OpenFang pin

Per [ADR-0003](docs/adr/0003-pin-openfang-by-commit.md), the upstream version is an
immutable, full Git commit SHA — never a branch or mutable tag:

```
acf2587e46be174c10200489c9a2d23a39a98aeb
```

`deploy/openfang.pin.json` is the single machine-readable source of truth. The compose
`openfang` service builds directly from that commit via a BuildKit git context, so the
running substrate is always traceable to the pin. The `OPENFANG_COMMIT` default in
`docker-compose.yml` must equal the `commit` field in the pin file; on a reviewed upgrade,
update the pin file, the compose default, and the
[integration contract](docs/integrations/berry-openfang.md) together in one change.

## Boot the stack

Prerequisites: Docker Engine with the Compose plugin and BuildKit (Docker Desktop, or
Docker CE + `docker-compose-plugin`) and Python 3 for repository checks.

```sh
cp .env.example .env

# Add at least one provider key for agent execution and set a strong,
# matching OPENFANG_API_KEY for the two server-side services.

python3 scripts/check-deploy-pins.py
python3 scripts/check-compose-config.py
docker compose up -d --build

docker compose ps
```

The API waits for healthy PostgreSQL, Valkey, and OpenFang, applies all forward-only
migrations under an advisory lock, then starts. `docker compose ps` should show all four
services healthy. The first OpenFang source build can take several minutes.

### Verify the stack

```sh
curl http://127.0.0.1:4000/health
curl http://127.0.0.1:4000/ready
curl http://127.0.0.1:4000/api/v1/config
curl http://127.0.0.1:4000/metrics

curl http://127.0.0.1:4200/api/health
curl -H "Authorization: Bearer $OPENFANG_API_KEY" \
  http://127.0.0.1:4200/api/agents

docker compose exec postgres pg_isready -U berry -d berry
docker compose exec valkey valkey-cli ping
```

Only the operational Go surface listed in `server/README.md` is expected at this
foundation stage. A healthy server does not imply unfinished product domains are
implemented.

### Storage and realtime settings

Local storage remains the default and persists under `berry-uploads`. For S3-compatible
storage, set `STORAGE_BACKEND=s3`, `S3_BUCKET`, and `S3_REGION`; `S3_ENDPOINT` enables a
custom endpoint, and an empty `S3_USE_PATH_STYLE` lets the server select path-style for
custom endpoints. `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and optional
`AWS_SESSION_TOKEN` are passed only to `berry-api`. They must never use a `NEXT_PUBLIC_*`
name or enter the browser bundle.

Compose enables Valkey and requires the realtime relay by default.
`REALTIME_NODE_ID` may stay empty to generate a unique process identity, while
`REALTIME_STREAM_MAXLEN`, `REALTIME_STREAM_TTL`, and `REALTIME_READ_BLOCK` bound the
disposable invalidation stream. Because `REALTIME_RELAY_REQUIRED=true`, `/ready` fails
when cross-node fanout cannot reach Valkey; PostgreSQL remains authoritative.

## Run workspaces on the host

### Go product server

Use `server/.env.example` for host addresses, then run the migrator and seeder before the API:

```sh
cd server
cp .env.example .env
set -a; . ./.env; set +a

go run ./cmd/migrate
go run ./cmd/seed
go run ./cmd/api
```

Go verification:

```sh
test -z "$(gofmt -l .)"
go vet ./...
go test -race ./...
go build ./cmd/api
go build ./cmd/migrate
go build ./cmd/seed
python3 ../scripts/check-sqlc-artifacts.py --require-tracked
go test ./pkg/db/...
```

The sqlc artifact check validates the tracked configuration, schema snapshot, named
queries, generated method surface, and locked SHA-256 inventory. It does **not** claim
regeneration. Actual sqlc regeneration remains policy-gated until a CLI dependency graph
compatible with Berry's permissive-only license policy is available; see
`server/README.md`.

### Bun gateway compatibility oracle

The gateway is intentionally not a Compose service. Run it against the loopback-published
dependencies only when comparing public contract behavior; do not run Bun and Go as
simultaneous writers to the same environment.

```sh
docker compose stop berry-api
cd apps/gateway
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun test
```

### Frontend

The browser uses same-origin Berry paths by default. Next.js proxies `/api/*`, `/health`,
`/ready`, and `/uploads/*` to the server-only `BERRY_API_ORIGIN` (default
`http://127.0.0.1:4000`). `NEXT_PUBLIC_BERRY_API_URL` is only an explicit cross-origin
development escape hatch; never put a token or OpenFang URL in it. A future frontend
container on the Compose network can target `http://berry-api:4000`.

`bun run dev` opens on `/{workspace}/runs` (default slug `berry`). The default sidebar is
issues, runs, reviews, and settings. Berry Dark is the default theme; Berry Light and
System are the other options. Visual language lives in
[the design system](docs/design-system.md). Empty queues and the run ledger are
intentional — do not restore Circle demo data or invent run records. Local create-issue
writes the Zustand store only until issue persistence is wired.

```sh
cd frontend
bun install --frozen-lockfile
cp .env.example .env.local
bun run dev
```

See [`frontend/README.md`](frontend/README.md) for the UI contract and env table.

### LLM providers

OpenFang auto-detects any provider whose key is present at boot. Anthropic is the default
model in OpenFang's shipped config. To use a local **Qwen via vLLM** model (the parent
issue's target), run vLLM on the host and point the container at it:

```sh
# in .env
VLLM_BASE_URL=http://host.docker.internal:8000
```

`host.docker.internal` resolves inside the container thanks to the `extra_hosts` entry in
the compose file (required on Linux/colima; a no-op on Docker Desktop).

## Operating the stack

```sh
docker compose logs -f openfang     # tail substrate logs
docker compose logs -f berry-api    # migration and API logs
docker compose restart openfang     # restart one service
docker compose down                 # stop, keep volumes (data persists)
docker compose build --no-cache openfang   # force a fresh OpenFang build
```

Do not use `docker compose down -v` as a routine reset: it irreversibly removes Berry
PostgreSQL data, uploads, Valkey state, and OpenFang's SQLite volume.

### PostgreSQL 16 to 17

The existing `berry-postgres` volume is PostgreSQL 16 data. Never change the image to 17
while reusing that volume. A future major-upgrade change must use a separate PostgreSQL 17
service and a new named volume, take and verify a `pg_dump`/restore (or reviewed
`pg_upgrade`) from 16, run Berry migrations and readiness checks against the copy, and
retain the 16 volume for rollback until cutover is accepted. The repository check currently
asserts the Compose image stays on `postgres:16-alpine`.

## Troubleshooting

- **`openfang` never becomes healthy** — first boot compiles Rust from source; give it a
  few minutes and check `docker compose logs openfang`. Confirm `OPENFANG_LISTEN` is
  `0.0.0.0:4200` (set by the compose file); the loopback default is unreachable through a
  published port.
- **`berry-api` never becomes ready** — inspect `docker compose logs berry-api`; readiness
  intentionally fails when migrations are incomplete or required Valkey is unavailable.
- **Securing the substrate** — published ports are loopback-only, but still set a strong
  `OPENFANG_API_KEY` and send it only from server-side callers. `/api/health` remains
  public.
- **Container can't reach a host-run vLLM/Ollama** — use `host.docker.internal`, not
  `localhost`, in `VLLM_BASE_URL` / `OLLAMA_BASE_URL`.
- **Port already in use** — override `BERRY_API_PORT`, `OPENFANG_PORT`, `POSTGRES_PORT`,
  or `VALKEY_PORT` in `.env`.

## Documentation

- [Product brief](docs/product-brief.md)
- [Design system](docs/design-system.md)
- [Architecture decisions](docs/adr/README.md) — incl. [ADR-0003: pin OpenFang by commit](docs/adr/0003-pin-openfang-by-commit.md)
- [Go product-server decision](docs/adr/0004-go-product-server.md)
- [OpenFang integration spec](docs/integrations/berry-openfang.md)
- [Gateway API contract](docs/api/gateway-v1.md)
- [Coding playbook](docs/coding-playbook.md)
- [Release-readiness report template](docs/release-readiness-report-template.md)
- [Changelog](CHANGELOG.md) — notable changes per release ([process](docs/changelog-process.md))

## Licensing

All dependencies are permissively licensed (MIT / Apache-2.0); MIT notices are retained.
"OpenFang" and "Linear" names and marks are not used as Berry product branding — the
OpenFang pin is engineering and operational metadata only.
