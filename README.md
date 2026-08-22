# Berry

Berry is a Linear-style team workspace where humans and AI coding agents share one
board. It is the product and persistence layer on top of
[OpenFang](https://github.com/RightNow-AI/openfang) (MIT/Apache-2.0), which provides the
agent execution substrate. Berry does **not** rebuild agent execution — it consumes
OpenFang's API.

| Path | What |
| ---- | ---- |
| `apps/gateway` | Bun + Hono BFF that adapts OpenFang into Berry's Linear-shaped API |
| `frontend` | Next.js + shadcn/ui app (Circle template) |
| `docs` | Product brief, ADRs, API contract, OpenFang integration spec |
| `docker-compose.yml` | Local stack: OpenFang + Postgres + Valkey |
| `deploy/openfang.pin.json` | Machine-readable OpenFang commit pin (ADR-0003) |

## The local stack

`docker-compose.yml` stands up the substrate and the backing services Berry builds
against:

| Service | Image / source | Host bind | Purpose |
| ------- | -------------- | --------- | ------- |
| `openfang` | built from pinned commit `acf2587e` | `4200` | Agent kernel + REST/WS/SSE + OpenAI-compatible API |
| `postgres` | `postgres:16-alpine` | `127.0.0.1:5432` | Berry's durable product state (ADR-0002) |
| `valkey` | `valkey/valkey:8-alpine` | `127.0.0.1:6379` | Shared cache + ephemeral coordination (ADR-0002) |

OpenFang keeps its own state in a SQLite database on the `openfang-data` volume; it does
**not** use the Berry Postgres or Valkey instances. Postgres and Valkey are Berry's own
backing services (consumed by `apps/gateway`).

Postgres and Valkey run with weak/no auth for local development, so their published ports
are **bound to `127.0.0.1`** — reachable from the host (and the host-run gateway) but never
from the LAN. OpenFang publishes on all interfaces because it enforces auth on its API; set
`OPENFANG_API_KEY` before exposing the host on an untrusted network (see
[Securing the API](#troubleshooting)).

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

## Boot from clean

Prerequisites: Docker Engine with the Compose plugin and BuildKit (Docker Desktop, or
Docker CE + `docker-compose-plugin`).

```sh
# 1. From the repo root, create your env file.
cp .env.example .env

# 2. Add at least one LLM provider key to .env so OpenFang can run agents,
#    e.g. ANTHROPIC_API_KEY=sk-ant-...  (leave the rest at their defaults).
#    Recommended: also set OPENFANG_API_KEY to a value of your choice.

# 3. Build the pinned OpenFang image and start all three services.
#    The first run compiles OpenFang from source (Rust) and can take several
#    minutes; later runs reuse the cached image.
docker compose up -d --build

# 4. Watch them become healthy.
docker compose ps
```

`docker compose ps` should show all three services as `healthy`.

### Verify the substrate

```sh
# Public health endpoint (no auth) — should return {"status":"ok",...}.
curl http://localhost:4200/api/health

# Authenticated route — send the bearer token you set as OPENFANG_API_KEY.
curl -H "Authorization: Bearer $OPENFANG_API_KEY" http://localhost:4200/api/agents

# Postgres and Valkey.
docker compose exec postgres pg_isready -U berry -d berry
docker compose exec valkey valkey-cli ping   # -> PONG
```

The `apps/gateway` service (run separately per `apps/gateway/README.md`) connects to this
stack using its default `.env` — `OPENFANG_BASE_URL=http://localhost:4200` and
`DATABASE_URL=postgres://berry:berry@localhost:5432/berry`. Set the gateway's
`OPENFANG_API_KEY` to the same value used here.

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
docker compose restart openfang     # restart one service
docker compose down                 # stop, keep volumes (data persists)
docker compose down -v              # stop AND wipe all volumes (full clean reset)
docker compose build --no-cache openfang   # force a fresh OpenFang build
```

A clean reset (`down -v`) is safe for local development: Berry reconstructs Valkey cache
entries from Postgres, and OpenFang starts from an empty `/data`. Do not run `down -v`
against data you want to keep.

## Troubleshooting

- **`openfang` never becomes healthy** — first boot compiles Rust from source; give it a
  few minutes and check `docker compose logs openfang`. Confirm `OPENFANG_LISTEN` is
  `0.0.0.0:4200` (set by the compose file); the loopback default is unreachable through a
  published port.
- **Securing the API** — with `OPENFANG_API_KEY` empty, requests OpenFang sees as
  loopback pass without a key (Docker port-forwarded requests often appear as loopback, so
  `curl localhost:4200/api/agents` may return `200`). Because that source-masking can also
  hide a LAN client's real address behind the Docker proxy, do **not** rely on the
  fail-closed guard when the host is on an untrusted network: set `OPENFANG_API_KEY` and
  send `Authorization: Bearer <key>` so every non-`/api/health` route requires it.
  `/api/health` always stays public.
- **Container can't reach a host-run vLLM/Ollama** — use `host.docker.internal`, not
  `localhost`, in `VLLM_BASE_URL` / `OLLAMA_BASE_URL`.
- **Port already in use** — override `OPENFANG_PORT`, `POSTGRES_PORT`, or `VALKEY_PORT`
  in `.env`.

## Documentation

- [Product brief](docs/product-brief.md)
- [Architecture decisions](docs/adr/README.md) — incl. [ADR-0003: pin OpenFang by commit](docs/adr/0003-pin-openfang-by-commit.md)
- [OpenFang integration spec](docs/integrations/berry-openfang.md)
- [Gateway API contract](docs/api/gateway-v1.md)
- [Coding playbook](docs/coding-playbook.md)
- [Release-readiness report template](docs/release-readiness-report-template.md)
- [Changelog](CHANGELOG.md) — notable changes per release ([process](docs/changelog-process.md))

## Licensing

All dependencies are permissively licensed (MIT / Apache-2.0); MIT notices are retained.
"OpenFang" and "Linear" names and marks are not used as Berry product branding — the
OpenFang pin is engineering and operational metadata only.
