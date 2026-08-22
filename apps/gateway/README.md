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
  observability/
    context.ts    # AsyncLocalStorage request context + W3C traceparent helpers
    metrics.ts    # OpenTelemetry meter + Prometheus exporter/serializer
    middleware.ts # per-request logging + metrics + trace context
    http.ts       # tracedFetch: instrumented outbound fetch for the OpenFang adapter
    index.ts      # observability barrel export
  routes/
    health.ts     # GET /health
    metrics.ts    # GET /metrics (Prometheus scrape)
tests/
  health.test.ts        # health endpoint + error handler coverage
  observability.test.ts # trace propagation, /metrics, request instrumentation
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
- `SERVICE_NAME` (default `berry-gateway`), `SERVICE_VERSION` (defaults to the package version) — identify the service in logs and the `target_info` metric
- `METRICS_ENABLED` (default `true`), `METRICS_PATH` (default `/metrics`)

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

## Docker

```sh
docker build -t berry-gateway .
docker run -p 4000:4000 berry-gateway
```

Multi-stage build on `oven/bun:1.3`; runs as the non-root `bun` user with a
`/health` HEALTHCHECK.
