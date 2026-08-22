# Gateway

- 2026-08-22 — `@berry/gateway` is Bun + Hono. Shipped: `/health`, `/metrics`, central error envelope, Pino + OTel, Drizzle schema. Missing: `/api/v1`, OpenFang adapter module, Valkey, run persistence, session HTTP (`apps/gateway/README.md`, `CHANGELOG.md`).
- 2026-08-22 — Public contract target is `docs/api/gateway-v1.md` (`/api/v1`, camelCase, cursor pages, `{ error: { code, message } }`). Storage names are not API names.
- 2026-08-22 — Tables: `users`, `sessions`, `boards`, `issues`, `assignments`, `comments`. Issue numbers from atomic `boards.issue_counter`. Assignee pair is both-or-neither (`apps/gateway/README-db.md`).
- 2026-08-22 — Observability: one `request.completed` log line; W3C `traceparent` via ALS; `tracedFetch` for upstream; Prometheus on `GET /metrics` (`apps/gateway/src/observability/`).
- 2026-08-22 — Env parsed in `src/config.ts`. `DATABASE_URL` is required for migrate but not yet in that Zod schema. Tests skip without it.
- 2026-08-22 — Reviewed, fixed, commented, and squash-merged gateway PRs #21 → #18 → #19 → #20 → #23 onto `main` (`64b925f`). Follow-ups: `requireAuth` on issues/comments/SSE, fold `api/dto` into `~/schemas`, `Idempotency-Key`.
