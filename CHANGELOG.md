# Changelog

All notable changes to Berry are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). See
[docs/changelog-process.md](docs/changelog-process.md) for how entries are written and
how releases are cut.

## [Unreleased]

No version has been tagged yet — Berry is pre-release. The first tagged release is cut at
milestone **M6 (Release 1)**; until then all shipped work accumulates here. This first
entry covers everything merged to `main` as of 2026-08-24, spanning the foundation
docs/knowledge base (**M0**), the OpenFang integration proof (**M1**), the gateway
service core (**M2**), and the Go product server, Temporal run orchestration, and Berry
shell that followed (**M3**). See the
[M2 milestone run report](docs/milestones/m2-gateway.md) for the integrated test state
and known issues.

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

- Go product server at `server/` (module
  `github.com/laravel42/berry-circle/server`) serving `/api/v1`, owning the Postgres
  schema and forward-only migrations, with CI gates for gofmt, vet, race tests,
  migration checksums, and sqlc artifact integrity — [d73862d].
- Temporal-backed run orchestration: continuous intake of `todo` issues and dispatch
  routed through Temporal so a crashed worker resumes rather than dropping work —
  ADR-0005 — [34c77d8], [7c95a14].
- Built-in orchestrator agent that takes intake when no other agent matches, routes each
  issue to the best-matching agent by capability, and authors plans behind a human
  approval gate — [8477049], [08250c0], [05c926b].
- Conversations, channel reachability, and the Infobip adapter, with an inbound channel
  webhook attributing replies to the originating conversation — [bc4312e], [4c62deb].
- Chat with workspace agents, end to end from the UI to the OpenFang runtime —
  [c06fc9c].
- Per-agent model selection: `GET /api/v1/agents/models` exposes the runtime catalog and
  `PUT /api/v1/agents/{id}/config` sets an agent's provider and model — [0200e4c].
- Workspace agents seeded from the OpenFang runtime at startup, including description,
  capabilities, and system prompt — [8c59882], [6af31ce], [43bcb86].
- Berry application shell from the design prototype: rail, tab navigator holding any
  route (not just nav destinations), and drawers capped at 1024px — [8ede6ed],
  [30d53b5], [515659d], [9c4c04c].
- Frontend wired to the Berry API with agent and run surfaces, replacing the empty
  `data/*` modules — [6e434ad].
- Gateway boards route with actor/enum alignment and run-event updates — [28a4da6].
- OpenFang and Temporal run as part of the default `docker compose` stack, with a
  Temporal UI at `127.0.0.1:8233` — [cd83fc8].

### Changed

- Issue, project, and agent descriptions are plain-text fields again. A rich editor
  round-tripped markdown through parse/serialize, and because the round trip is not
  byte-stable — bullet markers normalise, blank lines are inserted, and `web_search`
  escapes to `web\_search` — the commit guard compared unequal on every blur and rewrote
  content nobody edited, including agent system prompts — [9836625], [a1fc891],
  [b268d45], [fcdd40f].
- Inbox is the workspace landing route, replacing runs. The root, workspace index,
  post-login redirect, session gate, and both back-to-app links all move with it —
  [439512b].

### Removed

- The Crew/team module: 17 routes, 15 components, and its stores. Crew created a board
  and attached a lead and members client-side to a store with no persistence, so the
  leader the create dialog required was discarded on refresh, and `project.teamId` was
  the workspace id aliased — every "by team" breakdown grouped everything into one
  bucket. Boards remain the issue container; routing agents to work is the
  orchestrator's job — [035c8f8].

### Fixed

- Migration upgrade-path test suite (`apps/gateway/src/db/migrate.upgrade.test.ts`) now
  loads and skips cleanly on a fresh checkout without `DATABASE_URL`. The admin connection
  URL is deferred to call time so `describe.skip` no longer constructs `new URL("")` at
  test registration — BERR-50 ([#11]).

- Issue description, sub-issues, and the activity feed render when an issue is opened
  from the list. Opening from the list is a soft navigation, so the intercepting drawer
  route mounts and an `inDrawer` gate rendered the whole main column as `null` — the
  body appeared only on a hard page load — [ff46ba4].
- Inbox rows show the issue identifier (`PLATFORM-3`) instead of `11111111`. The payload
  carried only `issueId`, so the client sliced the UUID; the server now derives board
  slug and issue number on read, which also repairs rows already projected — [1157479].
- `PATCH` is admitted under the idempotent-write retry class, unblocking agent config
  updates — [391380a].
- Orchestrators are provisioned from the API and scoped per workspace, so a second
  workspace no longer collides on the upstream agent name — [6c4a9f4].
- `berry-worker` no longer inherits the API's HTTP healthcheck, which it cannot serve —
  [df755c7].
- Compose stack starts unattended: the Temporal healthcheck addresses the service rather
  than loopback, empty environment values no longer defeat defaults, and the Temporal UI
  image tag is pinned to a version that exists — [412d3fd].

### Security

- Docker Compose binds the published Postgres (`5432`) and Valkey (`6379`) ports to
  `127.0.0.1`, so the weak-/no-auth local-dev services are reachable from the host (and the
  host-run gateway) but never from the LAN. The README documents that `OPENFANG_API_KEY`
  must be set before exposing the host on an untrusted network — BERR-15 ([#13]).

- Chat reads and writes require thread participation. `Append` performed no workspace or
  participant check, so a member of one workspace could inject messages into another's
  thread, and reads were not participant-scoped — [37e86cd].

[Unreleased]: https://github.com/laravel42/berry-circle/commits/main
[cd882f4]: https://github.com/laravel42/berry-circle/commit/cd882f4
[0200e4c]: https://github.com/laravel42/berry-circle/commit/0200e4c
[035c8f8]: https://github.com/laravel42/berry-circle/commit/035c8f8
[05c926b]: https://github.com/laravel42/berry-circle/commit/05c926b
[08250c0]: https://github.com/laravel42/berry-circle/commit/08250c0
[1157479]: https://github.com/laravel42/berry-circle/commit/1157479
[28a4da6]: https://github.com/laravel42/berry-circle/commit/28a4da6
[30d53b5]: https://github.com/laravel42/berry-circle/commit/30d53b5
[34c77d8]: https://github.com/laravel42/berry-circle/commit/34c77d8
[37e86cd]: https://github.com/laravel42/berry-circle/commit/37e86cd
[391380a]: https://github.com/laravel42/berry-circle/commit/391380a
[412d3fd]: https://github.com/laravel42/berry-circle/commit/412d3fd
[439512b]: https://github.com/laravel42/berry-circle/commit/439512b
[43bcb86]: https://github.com/laravel42/berry-circle/commit/43bcb86
[4c62deb]: https://github.com/laravel42/berry-circle/commit/4c62deb
[515659d]: https://github.com/laravel42/berry-circle/commit/515659d
[6af31ce]: https://github.com/laravel42/berry-circle/commit/6af31ce
[6c4a9f4]: https://github.com/laravel42/berry-circle/commit/6c4a9f4
[6e434ad]: https://github.com/laravel42/berry-circle/commit/6e434ad
[7c95a14]: https://github.com/laravel42/berry-circle/commit/7c95a14
[8477049]: https://github.com/laravel42/berry-circle/commit/8477049
[8c59882]: https://github.com/laravel42/berry-circle/commit/8c59882
[8ede6ed]: https://github.com/laravel42/berry-circle/commit/8ede6ed
[9836625]: https://github.com/laravel42/berry-circle/commit/9836625
[9c4c04c]: https://github.com/laravel42/berry-circle/commit/9c4c04c
[a1fc891]: https://github.com/laravel42/berry-circle/commit/a1fc891
[b268d45]: https://github.com/laravel42/berry-circle/commit/b268d45
[bc4312e]: https://github.com/laravel42/berry-circle/commit/bc4312e
[c06fc9c]: https://github.com/laravel42/berry-circle/commit/c06fc9c
[cd83fc8]: https://github.com/laravel42/berry-circle/commit/cd83fc8
[d73862d]: https://github.com/laravel42/berry-circle/commit/d73862d
[df755c7]: https://github.com/laravel42/berry-circle/commit/df755c7
[fcdd40f]: https://github.com/laravel42/berry-circle/commit/fcdd40f
[ff46ba4]: https://github.com/laravel42/berry-circle/commit/ff46ba4
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
