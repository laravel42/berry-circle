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
  routes/
    health.ts     # GET /health
tests/
  health.test.ts  # bun:test coverage for the health endpoint + 404 handler
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

## Docker

```sh
docker build -t berry-gateway .
docker run -p 4000:4000 berry-gateway
```

Multi-stage build on `oven/bun:1.3`; runs as the non-root `bun` user with a
`/health` HEALTHCHECK.
