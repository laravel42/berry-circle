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
  db/
    client.ts     # shared drizzle handle (lazy, from DATABASE_URL)
    schema.ts     # Berry-owned tables (BERR-21)
  http/
    errors.ts     # ApiError + the contract's ErrorEnvelope
    validation.ts # Zod → 422/400 with details.fields
    pagination.ts # opaque scoped cursors + connection envelope
    context.ts    # requireDb + current-actor seam
  api/
    dto.ts        # Issue/Comment request schemas + serializers
    enums.ts      # status/priority storage <-> API mapping
    workflow.ts   # issue status-transition rules
    actors.ts     # actor display-name resolution
    lookups.ts    # issue-by-UUID-or-identifier
  routes/
    health.ts     # GET /health
    issues.ts     # /api/v1/issues[...]
    comments.ts   # /api/v1/issues/:id/comments, /api/v1/comments/:id
tests/
  health.test.ts          # health endpoint + error handler
  issues.routes.test.ts   # issue CRUD (DB-gated)
  comments.routes.test.ts # comment CRUD (DB-gated)
```

## API (v1)

Issue and comment resources per the normative contract in
[`docs/api/gateway-v1.md`](../../docs/api/gateway-v1.md), backed by Postgres:

- `GET|POST /api/v1/issues`, `GET|PATCH /api/v1/issues/{issueId}` (UUID or
  identifier, e.g. `BERRY-42`)
- `GET|POST /api/v1/issues/{issueId}/comments`
- `GET|PATCH|DELETE /api/v1/comments/{commentId}`

Collections use opaque cursor pagination (`first`, `after`); every non-2xx body
is the contract's `ErrorEnvelope`. Board, agent, and run resources plus SSE are
out of scope for this slice.

Unit tests always run; the route tests require a migrated Postgres via
`DATABASE_URL` and skip cleanly otherwise (matching the schema tests).

### Authentication seam (temporary)

Session auth is a separate deliverable (BERR-24). Until it lands, mutating
requests read the acting identity from `X-Berry-Actor-Type` (`user`|`agent`) and
`X-Berry-Actor-Id` headers (plus optional `X-Berry-Actor-Admin`); a `user` actor
must exist in `users`. BERR-24 replaces `requireActor` in `http/context.ts` with
token → session resolution — callers and the `401 UNAUTHENTICATED` behavior stay
the same. Agent display names are placeholders until the OpenFang adapter
(BERR-20) is wired into `api/actors.ts`.

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
- `DATABASE_URL` — Berry-owned Postgres. Optional; when unset the health endpoint still serves and the issue/comment routes return `503 DEPENDENCY_UNAVAILABLE`

## Docker

```sh
docker build -t berry-gateway .
docker run -p 4000:4000 berry-gateway
```

Multi-stage build on `oven/bun:1.3`; runs as the non-root `bun` user with a
`/health` HEALTHCHECK.
