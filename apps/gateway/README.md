# @berry/gateway

Berry BFF gateway — a Bun + Hono + TypeScript service that adapts the OpenFang
substrate API into the Linear-shaped product API consumed by the Berry frontend.

## Layout

```
src/
  index.ts        # prod entry: Bun.serve + graceful shutdown
  app.ts          # Hono app factory (middleware, routes, error handling)
  config.ts       # Zod-validated env config
  logger.ts       # Pino logger
  types.ts        # Shared Hono app env (variables) type
  http/
    errors.ts     # envelope-shaped HTTPException helpers (apiError, validationError, …)
  auth/
    tokens.ts     # session-token generation, hashing, bearer extraction
    sessions.ts   # session lifecycle (create / resolve / revoke) + email lookup
    middleware.ts # requireAuth / requireRole route guards, getAuthUser
    serialize.ts  # public User DTO
    types.ts      # AuthUser + Hono AuthEnv
  db/
    client.ts     # lazy, pooled request-time drizzle handle (getDb)
    schema.ts     # drizzle schema (users/sessions/boards/issues/…)
    migrate.ts    # migration runner
  observability/
    context.ts    # AsyncLocalStorage request context + W3C traceparent helpers
    metrics.ts    # OpenTelemetry meter + Prometheus exporter/serializer
    middleware.ts # per-request logging + metrics + trace context
    http.ts       # tracedFetch: instrumented outbound fetch for the OpenFang adapter
    index.ts      # observability barrel export
  routes/
    health.ts     # GET /health
    metrics.ts    # GET /metrics (Prometheus scrape)
    auth.ts       # POST /api/v1/auth/login, POST /logout, GET /me
tests/
  health.test.ts        # health endpoint + error handler coverage
  observability.test.ts # trace propagation, /metrics, request instrumentation
  auth.test.ts          # auth guards (no-DB) + login/me/logout/expiry/role (DB-gated)
```

## Commands

| Command          | Purpose                              |
| ---------------- | ------------------------------------ |
| `bun run dev`    | Dev server with hot reload           |
| `bun start`      | Production entry                     |
| `bun test`       | Run tests (bun:test)                 |
| `bun run lint`   | Biome lint + format check            |
| `bun run typecheck` | `tsc --noEmit`                    |

## Configuration

Copy `.env.example` to `.env`. Key values:

- `PORT` (default `4000`), `HOST`
- `OPENFANG_BASE_URL` — base URL of the OpenFang REST/OpenAI-compatible API (default `http://localhost:4200`)
- `OPENFANG_API_KEY` — optional bearer token for the substrate
- `DATABASE_URL` — Berry-owned Postgres; optional so the app boots and `bun test` runs without a DB (request paths that need it fail fast). Required at boot under `NODE_ENV=production`.
- `SESSION_TTL_HOURS` — login session lifetime before token expiry (default `720`, i.e. 30 days)
- `AUTH_ALLOW_PASSWORDLESS_LOGIN` — opt-in for the credential-less login path (default off; hard-ignored in production). See below.
- `SERVICE_NAME` (default `berry-gateway`), `SERVICE_VERSION` (defaults to the package version) — identify the service in logs and the `target_info` metric
- `METRICS_ENABLED` (default `true`), `METRICS_PATH` (default `/metrics`)

## Authentication

Release 1 uses opaque **session bearer tokens** (`Authorization: Bearer <token>`), per the
[gateway-v1 contract](../../docs/api/gateway-v1.md). Tokens are 256-bit random strings; only
their SHA-256 hash is stored in `sessions.token_hash`, and expiry is enforced on every
request.

| Endpoint | Auth | Purpose |
| -------- | ---- | ------- |
| `POST /api/v1/auth/login` | opt-in | `{ "email": "…" }` → `{ token, expiresAt, user }` for an existing user |
| `GET /api/v1/auth/me` | bearer | Current user (`id, email, name, avatarUrl, role, …`) |
| `POST /api/v1/auth/logout` | bearer | Revokes the presented session (`204`) |

Guard any other router with the exported middleware:

```ts
import { requireAuth, requireRole, getAuthUser } from "~/auth/middleware";

issues.use("*", requireAuth);                 // 401 without a valid session
issues.delete("/:id", requireRole("admin"), (c) => { … }); // 403 for non-admins
const user = getAuthUser(c);                  // typed { id, role, … }
```

The `users.role` column (`admin` | `member`, default `member`) is plumbed through login,
`me`, and the request context for authorization.

### Login credential model (interim)

Login authenticates by email against an existing `users` row — **no credential check**.
Because email addresses aren't secrets, that would let anyone mint an `admin` session, so the
path is gated: it returns `403 PASSWORDLESS_LOGIN_DISABLED` unless `AUTH_ALLOW_PASSWORDLESS_LOGIN=true`,
and the flag is **hard-ignored under `NODE_ENV=production`** — the insecure mode can never ship
to production or be enabled by default. A password/SSO credential store and user provisioning are
tracked follow-ups; a `sessions` sweeper (`deleteExpiredSessions()`) is provided for a scheduled
job but not yet wired to a scheduler. A login endpoint inherently reveals account existence
(a known email yields a token, an unknown one a `401`); that is accepted for this posture, not
hidden.

### Error envelope

Every error (including `404` and validation failures) is rendered centrally in `app.onError`
as `{ error: { code, message, requestId, details } }`, where `requestId` matches the
`X-Request-Id` response header and `details` is `null` when absent — per the contract's
`ErrorEnvelope`. Throw an `ApiError` (or the `unauthenticated()`/`forbidden()`/`validationError()`
helpers in `~/http/errors`); the boundary stamps the request id and preserves the header.

## Observability

Structured logging, request tracing, and metrics live in `src/observability/`.

**Logging** — Pino emits one structured `request.completed` line per request with
`requestId`, `traceId`, `method`, `path`, matched `route`, `status`, and
`durationMs`. `/health` and the metrics path log at `debug` to keep probe/scrape
noise down; 4xx logs at `warn`, 5xx at `error`. Auth headers, cookies, and API
keys are redacted.

**Tracing** — each request establishes an `AsyncLocalStorage` context carrying a
W3C trace. An inbound `traceparent` is continued; otherwise a fresh trace id is
minted. The active trace id is echoed back as the `x-trace-id` response header.
The OpenFang adapter propagates the trace upstream by routing calls through
`tracedFetch` (or spreading `getTraceHeaders()` into its request headers), which
also records the outbound-call metric.

**Metrics** — an OpenTelemetry `MeterProvider` feeds a Prometheus exporter
(`preventServerStart`) served on `GET /metrics` in the standard text exposition
format. Instruments:

| Metric | Type | Key attributes |
| ------ | ---- | -------------- |
| `http_server_request_duration_seconds` | histogram | `http_request_method`, `http_route`, `http_response_status_code` |
| `http_server_active_requests` | gauge | — |
| `openfang_client_request_duration_seconds` | histogram | `openfang_request_method`, `openfang_route`, `openfang_response_status_code` |

Route labels use the matched Hono route pattern (not the raw path) to keep
metric cardinality bounded.


## Issues and comments

`GET|POST /api/v1/issues`, `GET|PATCH /api/v1/issues/{issueId}` (UUID or identifier),
`GET|POST /api/v1/issues/{issueId}/comments`, and `GET|PATCH|DELETE /api/v1/comments/{commentId}`.
Collections use opaque cursor pagination. Mutating routes currently resolve the actor from
`X-Berry-Actor-*` headers (BERR-24 session swap is the follow-up). Create may start in
`backlog` / `todo` / `inProgress` / `cancelled`; `inReview` and `done` return
`409 INVALID_STATE_TRANSITION` so the review gate cannot be skipped.

## Docker

```sh
docker build -t berry-gateway .
docker run -p 4000:4000 berry-gateway
```

Multi-stage build on `oven/bun:1.3`; runs as the non-root `bun` user with a
`/health` HEALTHCHECK.
