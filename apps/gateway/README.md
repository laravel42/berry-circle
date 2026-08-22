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
  routes/
    health.ts     # GET /health
    auth.ts       # POST /api/v1/auth/login, POST /logout, GET /me
tests/
  health.test.ts  # bun:test coverage for the health endpoint + 404 handler
  auth.test.ts    # auth guards (no-DB) + login/me/logout/expiry/role (DB-gated)
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

## Docker

```sh
docker build -t berry-gateway .
docker run -p 4000:4000 berry-gateway
```

Multi-stage build on `oven/bun:1.3`; runs as the non-root `bun` user with a
`/health` HEALTHCHECK.
