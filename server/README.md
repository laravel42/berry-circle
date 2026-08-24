# Berry Go server foundation

This directory is a self-contained Go 1.26.6 module for Berry's product server.
It owns browser-facing product infrastructure and durable PostgreSQL facts.
OpenFang remains the only execution substrate; this module contains no daemon,
provider adapter, local process launcher, sandbox, or host-shell implementation.

This foundation intentionally exposes only operational endpoints:

- `GET /health`
- `GET /ready` and `GET /readyz`
- `GET /metrics` when enabled
- `GET /api/v1/config` with browser-safe capability booleans

Board, issue, comment, run, authentication, and other domain handlers belong to
later lanes. Domain packages register disjoint `httpapi.Mount` values rather
than editing a monolithic router.

## Requirements

- Go 1.26.6
- PostgreSQL 16 or 17
- Valkey when `VALKEY_ENABLED=true`
- the pinned OpenFang deployment for execution-backed features

PostgreSQL is authoritative. Valkey keys are versioned `berry:*` entries and
are always disposable.

## Local commands

From `server/`:

```sh
cp .env.example .env
set -a; . ./.env; set +a

go fmt ./...
go vet ./...
go test -race ./...
go build ./cmd/api
go build ./cmd/migrate
go build ./cmd/seed

go run ./cmd/migrate
go run ./cmd/seed
go run ./cmd/api
```

## Development seed

`go run ./cmd/seed` inserts an idempotent local dataset after migrations:

- user `prototype@berry.test` (admin; matches frontend auto-login)
- workspace `berry`, board `platform`
- three sample issues and projects for Kanban/board views

Compose runs the same seeder on every `berry-api` boot (`migrate && seed && api`).
Re-running the command is safe; rows upsert on stable UUIDs.

Database- or Valkey-backed tests skip when their corresponding environment URL
is absent. Realtime integration tests specifically require
`BERRY_TEST_VALKEY_URL`; they create one unique
`berry:realtime:v1:test-*:events` key and delete only that key. The normal unit
and endpoint suite needs no external service.

## Production object storage

`STORAGE_BACKEND` defaults to `local`. Local objects are bounded by
`STORAGE_MAX_BYTES`, written with an atomic rename beneath
`STORAGE_LOCAL_ROOT`, and accessed through a secure filesystem root that
rejects traversal and symlink escapes. SHA-256, content type, size, and caller
metadata are stored in private sidecars. Local download/upload descriptors use
the authenticated `/api/v1/storage/objects` Berry route and never expose an
on-disk path; the parent lane must mount that route and enforce workspace
authorization.

`STORAGE_BACKEND=s3` requires `S3_BUCKET`, `S3_REGION`, and a resolvable AWS
credential chain. Static credentials use the standard `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`, and optional `AWS_SESSION_TOKEN` variables; partial
static credentials fail validation without echoing values. `S3_ENDPOINT` (or
the compatible `AWS_ENDPOINT_URL`) enables an S3-compatible endpoint and
defaults to path-style requests for MinIO. `S3_USE_PATH_STYLE` is parsed
strictly. Direct uploads are staged to a bounded temporary file and carry a
full-object SHA-256; presigned PUTs require an exact size and SHA-256.

The original `storage.Backend` remains source-compatible. Domain code can
feature-detect `storage.MetadataBackend` and `storage.PresigningBackend` for
metadata and temporary request descriptors.

## Multi-instance realtime

`realtime.Distributed` composes the bounded local `Hub` with a Valkey relay.
The relay writes only validated workspace invalidations to the bounded,
expiring Redis Stream `berry:realtime:v1:events`. `REALTIME_NODE_ID`,
`REALTIME_STREAM_MAXLEN`, `REALTIME_STREAM_TTL`, and
`REALTIME_READ_BLOCK` control node identity and retention.
`REALTIME_RELAY_REQUIRED` defaults to `VALKEY_REQUIRED` for compatibility.

The stream is disposable and is never a fact store. A node snapshots the
current tail on first start and resumes its in-memory stream cursor on short
reconnects. Because trimming or expiry can still create a gap, active WebSocket
subscriptions are ended with a retry/resync close so clients reconnect and
re-fetch PostgreSQL. Optional relay outages preserve same-node delivery and do
not fail readiness. Required relay outages fail `Distributed.Check`.

WebSockets require both a workspace scope hook and a non-empty approved
`Origin`. They accept no client product messages, enforce read/write
deadlines and message limits, and deliver server-to-client invalidations only.

## sqlc

The executable source of truth remains `migrations/*.up.sql`;
`pkg/db/schema.sql` is sqlc's parser snapshot, and actual generated
output is checked in under `pkg/db/gen/`.

```sh
# Intended no-global-binary command:
go tool sqlc generate
```

Go 1.26.6 tool directives were verified with sqlc `v1.31.1`, but the directive
is deliberately not retained: the current CLI graph includes
`github.com/go-sql-driver/mysql` under MPL-2.0, which Berry's dependency policy
does not permit. Do not install a global binary or hand-edit generated files.
Restore the `tool github.com/sqlc-dev/sqlc/cmd/sqlc` directive and the
`go:generate go tool sqlc generate -f ../../sqlc.yaml` line only after a
policy-compatible sqlc distribution is available; then update the query SQL,
migration, parser snapshot, and generated output together.

## Migrations

`cmd/migrate` embeds the three forward-only foundation migrations, pins a
PostgreSQL session while holding an advisory lock, and applies each migration
transactionally. The ledger records SHA-256 checksums and refuses removed,
renamed, or modified migrations. Run the migrator before starting the API;
readiness stays unavailable until the ledger exactly matches the binary.

The initial migration set is an additive Berry schema squash designed for both
greenfield PostgreSQL and databases already migrated by the Bun/Drizzle
gateway. It does not import the legacy repository's migration history.

## Package map

- `internal/config`: strict environment parsing with secret-safe errors
- `internal/database`: pgx pools, transactions, and migration-aware readiness
- `internal/cache`: Valkey setup and fail-open optional cache boundary
- `internal/httpapi`: Chi registry, middleware, errors, cursors, idempotency,
  and rate limiting
- `internal/observability`: redacted `slog`, Prometheus, and exporter-free OTel
- `internal/storage`: secure atomic local objects plus AWS/S3-compatible storage
- `internal/realtime`: bounded local/Valkey fanout and authenticated WS hooks
- `internal/openfang`: server-only traced HTTP transport and retry classes
- `internal/platform`: shared dependency interfaces for domain modules
- `internal/handlers/platform`: liveness, readiness, metrics, and public config

## Deliberate next-lane gaps

- No product CRUD or authentication/session HTTP handlers are mounted yet.
- sqlc inputs and generated output are present, but regeneration is gated on a
  policy-compatible CLI dependency graph (the current CLI pulls MPL-2.0).
- Storage download/upload HTTP handlers are not mounted yet; local temporary
  request descriptors intentionally retain Berry authentication.
- Realtime has no durable replay by design. PostgreSQL remains authoritative,
  and the parent lane still needs to construct/start the managed broadcaster
  and mount the authenticated WebSocket route.
- OpenFang transport supplies safe request/retry primitives only. Agent,
  workflow, memory, and run projections remain adapter/domain work.
- No OpenTelemetry exporter is selected; W3C propagation and SDK hooks are
  ready for deployment-specific exporter configuration.
