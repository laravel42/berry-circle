# Changelog

All notable changes to Berry are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). See
[docs/changelog-process.md](docs/changelog-process.md) for how entries are written and
how releases are cut.

## [Unreleased]

No version has been tagged yet — Berry is pre-release. The first tagged release is cut at
milestone **M6 (Release 1)**; until then all shipped work accumulates here.

Entries below are a running record and are not rewritten. Several name components that no
longer exist — the Bun/Hono gateway, the Go product server, the pinned agent runtime
and Temporal — all removed on 2026-08-28; see the `Removed` section.

### Added

- GitHub App creation and installation, replacing configured OAuth credentials. Berry
  posts a manifest to GitHub (`POST /api/v1/integrations/github/app/manifest`), and the
  conversion callback stores the app id, both halves of the OAuth credential, the private
  key and the webhook secret, sealed with `INTEGRATION_ENCRYPTION_KEY`. The manifest
  declares its own `callback_urls` — both the API and app origins — so a `redirect_uri`
  cannot be registered wrong. Tables `github_apps` (one row) and `github_installations`
  (one per workspace then; one per account since migration `182`) arrive in migration
  `040`.
- Repository work runs on GitHub App installation tokens, minted per installation from
  the private key, cached until shortly before expiry, and coalesced so concurrent runs
  share one mint (`server-ts/src/integrations/github-app.ts`). Both the repository picker
  and the agent run path prefer them, falling back to a user connection only when the
  deployment has no App.
- `projects` and `goals` appear in the workspace rail by default, `projects` first.
  Sidebar preferences move to `sidebar-prefs-v6`, which does not carry the stored order
  or visibility forward — a stored preference would otherwise outrank the new default
  permanently.
- A live indicator beside `runtimes` in the rail while any run has not reached a terminal
  status, and the berry accent bar on the active rail item.

- Schema migration and development seeding in TypeScript: `server-ts/src/migrate` applies
  `server-ts/migrations/*.up.sql` forward-only under the `pg_advisory_lock` Berry has
  always used, against the same `berry_schema_migrations` ledger and the same SHA-256 per
  file, so a database migrated before the port is already current. `server-ts/src/seed`
  writes the development dataset. Both are idempotent and both run before the server binds
  a port (`pnpm migrate:server`, `pnpm seed:server`). Migration `032` drops the external
  runtime's id columns from `issues`, `agents` and `model_role_agents`; the one on
  `agents` was `NOT NULL`, so creating an agent had required inventing an id for a
  process that would never exist.

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
- Agent runtime integration spec mapping Berry features to runtime endpoints — BERR-10
  ([#5]).
- Gateway API contract v1 (`docs/api/gateway-v1.md`), the Linear-shaped surface the
  gateway will expose — BERR-11 ([#7]).
- Architecture Decision Record log with the first decisions: ADR-0001 (Bun + Hono
  gateway), ADR-0002 (Valkey for ephemeral state), and ADR-0003 (pin the runtime by
  commit) — BERR-12 ([#8]).
- Coding playbook documenting repo conventions grounded in the codebase: the
  two-workspace toolchain split (Biome gateway vs Prettier/ESLint frontend), TypeScript
  style, the Zod boundary-validation pattern, the central Hono error envelope, `bun:test`
  conventions, and the branch/PR review-gate workflow — BERR-13 ([#9]).
- Design-system baseline defining Berry's UX tokens for the frontend
  (`docs/design-system.md`) — BERR-14 ([#6]).
- Gateway consumption contract enumerating the runtime endpoints the gateway depends on
  — BERR-17 ([#10]).
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
- Local stack — `docker-compose.yml` standing up the agent runtime, Postgres, and Valkey.
  The runtime is built from an immutable pinned commit (`acf2587e`, per
  ADR-0003) via a BuildKit git context; includes a boot-from-clean guide in the
  README — BERR-15 ([#13]).
- Runtime integration smoke test exercising the live agent/workflow API end to end, with
  fault-isolated resource cleanup, abort-timeout hardening on body reads, and assertions
  on `usage.input_tokens` / `usage.output_tokens` (the Berry token-total dependency) —
  BERR-18 ([#12]).
- Gateway runtime adapter — typed native-fetch client for the pinned upstream agent,
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
  redacted), W3C trace propagation to the runtime adapter via an `AsyncLocalStorage`
  request context (`getTraceHeaders`/`tracedFetch`, `x-trace-id` response header), and a
  Prometheus `GET /metrics` endpoint backed by OpenTelemetry (`http_server_request_duration
  _seconds`, `http_server_active_requests`, and a runtime-client duration histogram).
  New config: `SERVICE_NAME`, `SERVICE_VERSION`, `METRICS_ENABLED`, `METRICS_PATH` —
  BERR-27 ([#22]).
- Gateway cache-aside module — a Bun-native Valkey store with configurable TTLs,
  tenant-scoped versioned keys, single-flight loading, exact/prefix invalidation,
  bounded operation timeouts, and fail-open circuit breaking. Domain helpers cover board
  and issue hot reads; route adoption remains a known integration gap in the
  M2 report — BERR-25 ([#19]).
- Gateway run-event SSE transport at `GET /api/v1/runs/{runId}/events`, with retained
  cursor replay, gap-free live fan-out, heartbeats, bounded subscriber buffers,
  disconnect cleanup, and terminal-event stream closure. Connecting runtime producers
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
- Chat with workspace agents, end to end from the UI to the agent runtime —
  [c06fc9c].
- Per-agent model selection: `GET /api/v1/agents/models` exposes the runtime catalog and
  `PUT /api/v1/agents/{id}/config` sets an agent's provider and model — [0200e4c].
- Workspace agents seeded from the agent runtime at startup, including description,
  capabilities, and system prompt — [8c59882], [6af31ce], [43bcb86].
- Berry application shell from the design prototype: rail, tab navigator holding any
  route (not just nav destinations), and drawers capped at 1024px — [8ede6ed],
  [30d53b5], [515659d], [9c4c04c].
- Frontend wired to the Berry API with agent and run surfaces, replacing the empty
  `data/*` modules — [6e434ad].
- Gateway boards route with actor/enum alignment and run-event updates — [28a4da6].
- The agent runtime and Temporal run as part of the default `docker compose` stack, with a
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

- A workspace reaches repositories in several GitHub accounts at once — a personal account
  and any number of organisations. `github_installations` is keyed by workspace *and*
  installation (migration `182`), with a unique index on `installation_id` making
  "an installation belongs to exactly one workspace" a database rule rather than an
  application check. Repository listings merge across accounts and say which account each
  repository came from; a token is minted against the installation that owns the
  repository, so an organisation's repository is no longer fetched with a personal
  account's token. Settings lists the connected accounts with what GitHub granted each and
  how many of this workspace's repositories live under it, offers **Add another account**,
  and disconnects one at a time through
  `DELETE /api/v1/github/:workspaceId/accounts/:installationId`. Webhooks resolve by
  installation id, which was already true and is now asserted.
- Creating a project is how work is planned. Choosing **AI workflow** as the project lead
  generates a plan against the new project and starts it once generation succeeds, which
  is what produces the tasks; AutoGate appears only beside that lead. The plan is started
  by the preview under the same `startPlanBlocker` guard the Start button uses, so a
  blocked, invalid or still-generating plan is held back and a high-risk one still goes to
  `pendingApproval`.
- Goals are a read-only surface. The list, detail and rail no longer offer to create,
  rename, re-status or re-plan one, and the detail page says which of its tasks put it in
  its state. Four states are shown — Planned, In Progress, Blocked, Done.
- GitHub's state on the integrations page is the App's, not a leftover user connection's:
  Not connected, Not installed, then Connected. The OAuth Connect and Disconnect buttons
  are hidden for GitHub, leaving one path.

- `docker-compose.yml` runs the TypeScript server as `berry-api` on `127.0.0.1:4000`,
  built from `server-ts/Dockerfile`, with `postgres`, `minio` and the `minio-bucket` job.
  It migrates and seeds before starting. `scripts/check-compose-config.py` asserts the new
  invariants.
- `frontend/next.config.ts` proxies to one origin. `BERRY_TS_API_ORIGIN` and the
  `TYPESCRIPT_ROUTES` split are gone, as is the `/uploads/*` rewrite — the server has no
  such route.
- `.env.example` covers only what the stack reads. Variables for the removed components
  (the agent runtime, Temporal, intake, the planner, Activepieces, Infobip, the integration OAuth
  clients, Valkey, `STORAGE_BACKEND`, `TRUSTED_ORIGINS`, `METRICS_ENABLED`) are gone.

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

- The New goal dialog, its store and provider, and the goal create, patch, link and
  unlink clients. Archive is the only goal write left.
- The "Plan something" buttons from the goals and projects surfaces, and the project
  header's "Generate tasks" button — the latter called
  `POST /api/v1/projects/:id/generated-issues`, which the server does not register, so
  every press answered 404.

- The Go product server (`server/`), its Temporal worker, and the Bun/Hono gateway
  (`apps/gateway/`). With them go the prefixes only they served: `/api/v1/runs`,
  `/workflows`, `/workflow-runs`, `/hooks`, `/approvals`, `/plans`, `/conversations`,
  `/integrations`, `/inbox`, `/search`, `/views`, `/catalogs`, `/runtime`, the multipart
  upload at `/issues/:ref/attachments`, and `/metrics`. Those paths answer 404, and
  `GET /api/v1/config` reports the reduced capability set. **There is no run
  orchestration:** `POST /internal/runs` is the only way to start an agent and nothing in
  the product calls it.
- The pinned external agent runtime, its compose service, its pin and config files, and
  its data volume. Berry runs agents in-process (ADR-0008).
- The `temporal` and `temporal-ui` services (their only client was the Go worker), the
  `valkey` service (the realtime hub is built with a null relay, so events replay from
  PostgreSQL on the next poll), and the `berry-uploads` volume (artifacts are S3-only).
- `deploy/sqlc-artifacts.lock.json` and `scripts/check-sqlc-artifacts.py`, which gated
  Go code generation.
- The frontend model playground (`components/common/settings/model-playground.tsx`) and
  `lib/runtime.ts`. Both existed to probe `/api/v1/runtime/*`, which no longer exists.
- ADRs 0001 (Bun/Hono gateway), 0003 (pin the runtime by commit), 0004 (Go product
  server), 0005 (Temporal run orchestration) and 0007 (workflows, planning and the
  Activepieces adapter) were withdrawn with the subjects they decided, along with the
  runtime integration and consumption docs, `docs/integrations/native-providers.md`,
  `docs/milestones/m2-gateway.md` and `docs/plans/temporal-run-orchestration.md`. The
  numbers are not reused; `docs/adr/README.md` records the gap.

- The Crew/team module: 17 routes, 15 components, and its stores. Crew created a board
  and attached a lead and members client-side to a store with no persistence, so the
  leader the create dialog required was discarded on refresh, and `project.teamId` was
  the workspace id aliased — every "by team" breakdown grouped everything into one
  bucket. Boards remain the issue container; routing agents to work is the
  orchestrator's job — [035c8f8].

### Fixed

- An integration connection whose credential has expired no longer reports itself
  connected. `ConnectionRepository` derives the status from `expires_at` on the same clock
  and margin `token()` already refuses on, so `/integrations/providers` and
  `/integrations/connections` cannot disagree — a GitHub connection showed green for eight
  days while every call answered `409 CONNECTION_UNUSABLE`.
- A plan carrying any validation warning failed to parse in the browser and took the whole
  plan page down with it. `fieldErrorSchema.severity` is optional: the server does not send
  it, because the array a problem arrives in — `errors` or `warnings` — is its severity.
- Migration `039` reverts `038`, which was applied by a routine API restart before
  [ADR-0010](docs/adr/0010-goals-as-derived-task-groups.md) was accepted. `038` dropped
  `goals.source`, which the goals mount still selects, so `/api/v1/goals` answered 500.

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

- The GitHub App installation callback verifies the `installation_id` it is handed instead
  of storing it. The id arrives in a query parameter on a redirect the person controls, and
  an App JWT authenticates the App rather than the person — so an unchecked id let a member
  of one workspace point it at another account's installation and mint tokens for
  repositories they were never given. The callback now resolves the installation through
  `GET /app/installations/{id}`, records the real account instead of nulls, and refuses one
  another workspace already holds.

- Docker Compose binds the published Postgres (`5432`) and Valkey (`6379`) ports to
  `127.0.0.1`, so the weak-/no-auth local-dev services are reachable from the host (and the
  host-run gateway) but never from the LAN. The README documents that the runtime API key
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
