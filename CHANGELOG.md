# Changelog

All notable changes to Berry are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). See
[docs/changelog-process.md](docs/changelog-process.md) for how entries are written and
how releases are cut.

## [Unreleased]

No version has been tagged yet — Berry is pre-release. The first tagged release is cut at
milestone **M6 (Release 1)**; until then all shipped work accumulates here. This first
entry covers everything merged to `main` as of 2026-08-22, spanning the foundation
docs/knowledge base (**M0**), the OpenFang integration proof (**M1**), and the gateway
service core (**M2**). See the [M2 milestone run report](docs/milestones/m2-gateway.md)
for the integrated test state and known issues.

### Added

- Product brief — what Berry is, who it is for, the issue → agent → review product motion,
  Release 1 scope (web app only), and the licensing posture — BERR-9 ([cd882f4]).
- OpenFang integration spec mapping Berry features to OpenFang endpoints
  (`docs/integrations/berry-openfang.md`) — BERR-10 ([#5]).
- Gateway API contract v1 (`docs/api/gateway-v1.md`), the Linear-shaped surface the
  gateway will expose — BERR-11 ([#7]).
- Architecture Decision Record log with the first decisions: ADR-0001 (Bun + Hono
  gateway), ADR-0002 (Valkey for ephemeral state), and ADR-0003 (pin OpenFang by
  commit) — BERR-12 ([#8]).
- Coding playbook documenting repo conventions grounded in the codebase: the
  two-workspace toolchain split (Biome gateway vs Prettier/ESLint frontend), TypeScript
  style, the Zod boundary-validation pattern, the central Hono error envelope, `bun:test`
  conventions, and the branch/PR review-gate workflow — BERR-13 ([#9]).
- Design-system baseline defining Berry's UX tokens for the frontend
  (`docs/design-system.md`) — BERR-14 ([#6]).
- OpenFang gateway consumption contract enumerating the endpoints the gateway depends on
  (`docs/api/openfang-gateway-consumption.md`) — BERR-17 ([#10]).
- Gateway service scaffold — Bun + Hono + TypeScript workspace under `apps/gateway` with a
  `/health` endpoint, a central Hono error envelope, graceful shutdown that drains
  in-flight requests, env-error redaction, and Biome + `bun:test` tooling plus a
  Dockerfile — BERR-19 ([#2]).
- Gateway Postgres schema and migrations — Berry-owned `users`, `sessions`, `boards`,
  `issues`, `assignments`, and `comments` tables via drizzle-orm, a migration runner, and
  an upgrade-safe `0001` migration that remediates pre-fix data (dangling comment parents,
  half-populated assignees, non-array board columns, uninitialized `issue_counter`) before
  adding each new constraint; ships constraint and upgrade-path integration tests —
  BERR-21 ([#1]).
- Frontend app — the Circle template (MIT, upstream `7785985`) vendored into `frontend/`,
  stripped of all demo/mock data (lists boot empty), wired to the gateway seam via env
  (`NEXT_PUBLIC_BERRY_API_URL`, `NEXT_PUBLIC_WORKSPACE_SLUG`, `NEXT_PUBLIC_ISSUE_PREFIX`),
  and rebranded to Berry while retaining the upstream MIT notice — BERR-28 ([#4]).
- Local stack — `docker-compose.yml` standing up OpenFang, Postgres, and Valkey. OpenFang
  is built from an immutable pinned commit (`deploy/openfang.pin.json`, `acf2587e`, per
  ADR-0003) via a BuildKit git context; includes a boot-from-clean guide in the
  README — BERR-15 ([#13]).
- OpenFang integration smoke test exercising the live agent/workflow API end to end, with
  fault-isolated resource cleanup, abort-timeout hardening on body reads, and assertions
  on `usage.input_tokens` / `usage.output_tokens` (the Berry token-total dependency) —
  BERR-18 ([#12]).
- Gateway OpenFang adapter — typed native-fetch client for the pinned upstream agent,
  execution, memory, workflow, audit, session, and usage endpoints, with Zod boundary
  validation, normalized errors, idempotency-aware retries, timeouts, and typed SSE
  parsing that reports interrupted streams without redispatching — BERR-20 ([#21]).
- Shared gateway DTO schemas for Board, Issue, Comment, Agent, Run, pagination, errors,
  and the 11 documented SSE event types. Public types derive from their Zod schemas and
  preserve the contract's camel-case enum spelling at the API boundary — BERR-22 ([#17]).
- Gateway issue & comment CRUD endpoints (`/api/v1/issues`, `/api/v1/comments`) backed by
  Postgres, per the gateway contract: identifier-or-UUID lookup, server-side issue-number
  allocation, filtered listing with opaque millisecond-precise cursor pagination,
  workflow-enforced status transitions, one-level comment threading, the shared
  `ErrorEnvelope`, and Zod request validation — with unit and DB-gated route tests. The
  request/response schemas are a self-contained slice pending the shared DTO module
  (BERR-22); a temporary actor header seam stands in for session auth (BERR-24) —
  BERR-23 ([#23]).
- Gateway session authentication — `POST /api/v1/auth/login` (email → session token + user),
  `GET /api/v1/auth/me`, and `POST /api/v1/auth/logout`, backed by opaque 256-bit bearer
  tokens whose SHA-256 hash alone is stored (`sessions.token_hash`), with expiry enforced on
  every request and revocation on logout. Adds `requireAuth`/`requireRole` route guards
  (exported for other routers) and a `users.role` column (`admin`/`member`, default `member`,
  migration `0002`) plumbed through login, `me`, and the request context. The credential-less
  login path is gated behind `AUTH_ALLOW_PASSWORDLESS_LOGIN` (off by default, hard-ignored
  under `NODE_ENV=production`, else `403 PASSWORDLESS_LOGIN_DISABLED`). Error responses now
  carry the contract-required `error.requestId` (matching `X-Request-Id`) and `error.details`,
  rendered centrally in `app.onError`. New config keys `DATABASE_URL`, `SESSION_TTL_HOURS`,
  and `AUTH_ALLOW_PASSWORDLESS_LOGIN`; `DATABASE_URL` is required at boot in production —
  BERR-24 ([#18]).
- Gateway observability — structured Pino request logging (one `request.completed` line per
  request with `requestId`, `traceId`, matched `route`, `status`, `durationMs`; secrets
  redacted), W3C trace propagation to the OpenFang adapter via an `AsyncLocalStorage`
  request context (`getTraceHeaders`/`tracedFetch`, `x-trace-id` response header), and a
  Prometheus `GET /metrics` endpoint backed by OpenTelemetry (`http_server_request_duration
  _seconds`, `http_server_active_requests`, `openfang_client_request_duration_seconds`).
  New config: `SERVICE_NAME`, `SERVICE_VERSION`, `METRICS_ENABLED`, `METRICS_PATH` —
  BERR-27 ([#22]).
- Gateway cache-aside module — a Bun-native Valkey store with configurable TTLs,
  tenant-scoped versioned keys, single-flight loading, exact/prefix invalidation,
  bounded operation timeouts, and fail-open circuit breaking. Domain helpers cover board
  and issue hot reads; route adoption remains a known integration gap in the
  [M2 report](docs/milestones/m2-gateway.md) — BERR-25 ([#19]).
- Gateway run-event SSE transport at `GET /api/v1/runs/{runId}/events`, with retained
  cursor replay, gap-free live fan-out, heartbeats, bounded subscriber buffers,
  disconnect cleanup, and terminal-event stream closure. Connecting OpenFang producers
  to this in-memory event-store seam is deferred to the agent execution loop — BERR-26
  ([#20]).

### Fixed

- Migration upgrade-path test suite (`apps/gateway/src/db/migrate.upgrade.test.ts`) now
  loads and skips cleanly on a fresh checkout without `DATABASE_URL`. The admin connection
  URL is deferred to call time so `describe.skip` no longer constructs `new URL("")` at
  test registration — BERR-50 ([#11]).

### Security

- Docker Compose binds the published Postgres (`5432`) and Valkey (`6379`) ports to
  `127.0.0.1`, so the weak-/no-auth local-dev services are reachable from the host (and the
  host-run gateway) but never from the LAN. The README documents that `OPENFANG_API_KEY`
  must be set before exposing the host on an untrusted network — BERR-15 ([#13]).

[Unreleased]: https://github.com/laravel42/berry-circle/commits/main
[cd882f4]: https://github.com/laravel42/berry-circle/commit/cd882f4
[#1]: https://github.com/laravel42/berry-circle/pull/1
[#2]: https://github.com/laravel42/berry-circle/pull/2
[#4]: https://github.com/laravel42/berry-circle/pull/4
[#5]: https://github.com/laravel42/berry-circle/pull/5
[#6]: https://github.com/laravel42/berry-circle/pull/6
[#7]: https://github.com/laravel42/berry-circle/pull/7
[#8]: https://github.com/laravel42/berry-circle/pull/8
[#9]: https://github.com/laravel42/berry-circle/pull/9
[#10]: https://github.com/laravel42/berry-circle/pull/10
[#11]: https://github.com/laravel42/berry-circle/pull/11
[#12]: https://github.com/laravel42/berry-circle/pull/12
[#13]: https://github.com/laravel42/berry-circle/pull/13
[#17]: https://github.com/laravel42/berry-circle/pull/17
[#18]: https://github.com/laravel42/berry-circle/pull/18
[#19]: https://github.com/laravel42/berry-circle/pull/19
[#20]: https://github.com/laravel42/berry-circle/pull/20
[#21]: https://github.com/laravel42/berry-circle/pull/21
[#22]: https://github.com/laravel42/berry-circle/pull/22
[#23]: https://github.com/laravel42/berry-circle/pull/23
