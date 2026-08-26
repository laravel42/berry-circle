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

- Planning and workflows, phase 4.5 (server): the extended node set and triggers. `switch`
  (first matching case, else the default; the other branches are recorded as skipped),
  `foreach` (one step row per body step per item, `note[0]` … `note[N-1]`, walked in
  item order with `item` in scope and the results aggregated under the loop's output;
  `maxItems` 1–100, default 25; body steps may wait), `transform` (references and
  templates into an output, no code) and `subworkflow` (a child run of another active
  workflow in the workspace with the step input as `trigger.input`, parent and depth
  recorded on the run, resumed through the child's `workflow.run.*` outcome; cycles and
  chains deeper than 3 are refused at validation) now execute natively. Schedule
  triggers fire: `internal/cron` parses five-field expressions and computes fire times
  on the timezone's wall clock (DST-safe), the in-process scheduler claims due
  workflows inside the dispatcher's loop, and with `TEMPORAL_ENABLED` activation
  registers a Temporal Schedule whose every fire runs `berry.AutomationScheduledRun` —
  both paths create one run per instant, idempotent on
  `schedule:<workflowId>:<instant>`, and skip instants missed for more than an hour.
  `POST /api/v1/agents/{id}/ask` answers one bounded question as JSON checked against
  the caller's schema (one chat completion, never retried, recorded in `agent_asks`
  with usage and cost; `422 ANSWER_INVALID` with a decode hint, `412 AGENT_UNAVAILABLE`).
  `POST /api/v1/hooks/{provider}` ingests GitHub, Slack and Linear webhooks (signature
  verified over the raw body, deduplicated on the provider's delivery id, one
  `integration.webhook.received` fact scoped to the owning workspace, opaque `404` on
  every refusal) and the dispatcher starts workflows whose `integration` trigger names
  the provider and event; Berry's own provider matches `integration` triggers on its
  topics too. Migration `025_extended_nodes_and_triggers` (indexed step ids, run
  parent links, the dispatcher index with `workflow.run.*`, the integration trigger
  index, `agent_asks`). The frontend half (node configuration UI, schedule trigger in the
  dialog and canvas) follows separately.
- Planning and workflows, phase 5a (server): the planner generates plans. `POST
  /api/v1/plans/generate` (202) turns a request into a BerryPlan v1 through four lean
  model-role agents Berry provisions on the runtime at boot (`model_role_agents`:
  classifier, planner, repair, critic — spawned with the configured provider/model, the
  `PLANNER_MAX_OUTPUT_TOKENS` output cap, a high hourly token budget and no tools;
  model and prompt drift is patched in place, limit drift only warns). The pipeline runs
  in a tracked goroutine bounded by `PLANNER_TIMEOUT`: intent extraction (blocking
  questions stop before a plan exists, `validation.status = "blocked"`), a deterministic
  context stage inside `PLANNER_CONTEXT_BUDGET_BYTES` (agents with skills, tools and
  limits, open issues by entity term, live workflows, connections by status only, policies,
  Berry events — never a credential), generation with a JSON-object response format, the
  full validator (structural, workflow, agent, safety, scope, duplicate and permission
  rules; `CONNECTION_MISSING` is a warning only for providers the plan declares under
  `requiredConnections`), up to `PLANNER_MAX_REPAIRS` repair rounds with the exact
  validator errors (the recorded exception to never retrying a paid call), and up to
  `PLANNER_MAX_CRITIC_ROUNDS` critic rounds whose revisions are kept only when they
  validate. Every stage is one `planner_events` row (stage, role, usage, cost, codes and
  ids — no prompts) and a `plan.updated` fact on the workspace stream; `GET /plans/{id}`
  shows `generation.stage` while running; exhausted repairs leave the last IR with
  `generation.error = "PLAN_INVALID"` and approve/compile answer `409 PLAN_INVALID`
  (`PLAN_BUSY` while generating). `GET /api/v1/plans/roles` (admins) lists the roles;
  `PLANNER_UNAVAILABLE` (412) answers when none is provisioned. Prometheus:
  `berry_planner_stage_duration_seconds{stage,outcome}`, `berry_planner_tokens_total{role,direction}`.
- Planning and workflows, phase 1b (server): workflows execute. A native runner walks a
  run through the MVP node set (`condition`, `wait`, `approval`, `create_issue`,
  `update_issue`, `agent` inline and issue mode, `action` for Berry's own tools; the rest
  answer `NODE_TYPE_UNSUPPORTED`), records every step attempt on the run ledger and parks
  the run on what a step waits for — an approval, an agent run (resumed only by
  `run.completed`/`run.failed`, never by the per-turn `done`), an issue, a timer or an
  event. A second outbox consumer, the trigger dispatcher, turns `issue.*` and the other
  Berry facts into runs with a receipt per event, resumes parked runs, releases dependent
  issues (`blocked → todo`) when their blocker completes and moves goals with their
  issues; an expiry sweep closes approvals nobody decided (`APPROVAL_EXPIRED`); `agent.*`
  and `artifact.created` facts reach the outbox. With `TEMPORAL_ENABLED` runs execute
  through the `berry.AutomationOrchestration` Temporal workflow on the worker (step
  activities are never retried; cancelling a run signals its orchestration), otherwise on
  an in-process pool; both drive one runner. `POST /api/v1/workflows/{id}/runs` runs a
  workflow by hand (`202`, `WORKFLOW_NOT_ACTIVE`, `WORKFLOWS_DISABLED`), activation and
  pause start and stop triggers where a runtime call is needed (the schedule seam), and
  `POST /api/v1/hooks/workflows/{id}/{token}` receives webhook-trigger deliveries without
  a session (digest-compared token, 1 MiB cap, `X-Berry-Delivery-Id` idempotency, 60
  deliveries per minute per workflow). Provider actions without a native client fail with
  `TOOL_NOT_EXECUTABLE` before any approval is requested.
- Planning and workflows, phase 1a (server): goals, plans, approvals and workflows as
  product state. `GET|POST /api/v1/goals` with lifecycle, issue links, and progress
  (issues, active workflows, pending approvals); `/api/v1/plans/{id}` read, versions,
  planner events, validate, approve → transactional compile (goal promoted, issues placed
  `todo`/`blocked`/`backlog` by rule, labels from required capabilities, dependency edges,
  `issueStart` gates, workflow drafts), reject, and compile retry; `/api/v1/approvals`
  list/get/create and approve/reject with the addressee-or-role rule, where approving an
  `issueStart` gate releases the issue to `todo` (or `blocked` while blockers remain);
  `/api/v1/workflows` CRUD with definition validation (`DEFINITION_INVALID` JSON-pointer
  fields), versions, activate/pause as recorded decisions (`CONNECTIONS_MISSING`,
  `WORKFLOW_ENGINE_DISABLED`, admin-only high risk) and webhook secret rotation;
  `/api/v1/workflow-runs` list, detail with steps, cancel, and the run ledger SSE stream;
  `GET /api/v1/events?workspaceId=` replaying goal, workflow, approval, plan, issue, agent
  and artifact facts; issues gain `goalId`, `goal`/`origin`/`dependsOn`/`blocks`,
  `/{issueRef}/dependencies` (`DEPENDENCY_CYCLE`) and answer `409 APPROVAL_REQUIRED` with
  the gating approval id; intake never selects an issue with open blockers; agents gain
  Berry-authored `skills`, manifest `limits`, `GET /api/v1/agents/capabilities`, and
  planner role agents are excluded from workspace sync; the inbox learns `approvals`,
  `goals` and `workflows` categories; Berry's own provider declares its trigger and action
  tools; `AUTOMATION_*`, `PLANNER_*` and `ACTIVEPIECES_*` configuration and the
  `planner`/`workflows`/`workflowEngine` capabilities. Execution (dispatcher, scheduler,
  runner, hooks) follows in phase 1b.
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
- Issue mutation events. `POST/PATCH/DELETE /api/v1/issues`, the `issue-query` batch
  routes and project planning now write `issue.created`, `issue.updated`,
  `issue.assigned`, `issue.started`, `issue.completed` and `issue.deleted` to the outbox
  inside the mutating transaction and publish them live after commit, so the board stream
  and (later) automation triggers see a person's edits, not only a run's — ADR-0007.
- ADR-0007 (Proposed): workflows and AI planning — the `Workflow` product noun over the
  `automation` Go/SQL vocabulary, Berry-native execution with an optional Activepieces
  adapter that fails closed, the bounded planner repair loop as a recorded exception to
  the never-retry-a-paid-call rule, and the licence audit that gates the adapter.

### Changed

- Durable events carry an explicit board scope. `outbox_events` gains `board_id`
  (migration `019_outbox_scope`) and `workspace_id` always holds the workspace; the run
  lane used to store the board id there, which hid every comment and collaboration event
  from `GET /api/v1/events?boardId=`. The stream envelope gains `workspaceId`, `runId` and
  `sequence` are null for facts no run produced, and `comment.created` now appears on the
  board stream. Realtime events fan out to both the workspace and the board subscription
  scope — ADR-0007.
- Issue identifiers use the workspace issue prefix (first three characters of the
  workspace name) plus the board sequential number — for example `BER-5` instead of
  `PLATFORM-5`. Lookups, search, inbox, and run dispatch all format and resolve the
  same `PREFIX-N` shape.
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
