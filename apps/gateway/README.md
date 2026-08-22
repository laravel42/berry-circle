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
- `DATABASE_URL` — Berry-owned Postgres; optional so the app boots and `bun test` runs without a DB (request paths that need it fail fast)
- `SESSION_TTL_HOURS` — login session lifetime before token expiry (default `720`, i.e. 30 days)

## Authentication

Release 1 uses opaque **session bearer tokens** (`Authorization: Bearer <token>`), per the
[gateway-v1 contract](../../docs/api/gateway-v1.md). Tokens are 256-bit random strings; only
their SHA-256 hash is stored in `sessions.token_hash`, and expiry is enforced on every
request.

| Endpoint | Auth | Purpose |
| -------- | ---- | ------- |
| `POST /api/v1/auth/login` | public | `{ "email": "…" }` → `{ token, expiresAt, user }` for an existing user |
| `GET /api/v1/auth/me` | bearer | Current user (`id, email, name, avatarUrl, role, …`) |
| `POST /api/v1/auth/logout` | bearer | Revokes the presented session (`204`) |

Guard any other router with the exported middleware:

```ts
import { requireAuth, requireRole, getAuthUser } from "~/auth/middleware";

issues.use("*", requireAuth);                 // 401 without a valid session
issues.delete("/:id", requireRole("admin"), (c) => { … }); // 403 for non-admins
const user = getAuthUser(c);                  // typed { id, role, … }
```

Login authenticates by email against an existing `users` row (self-hosted, single-workspace
Release 1); a password/SSO credential store and user provisioning are tracked follow-ups.
The `users.role` column (`admin` | `member`, default `member`) is plumbed through login,
`me`, and the request context for authorization.

## Docker

```sh
docker build -t berry-gateway .
docker run -p 4000:4000 berry-gateway
```

Multi-stage build on `oven/bun:1.3`; runs as the non-root `bun` user with a
`/health` HEALTHCHECK.
