# Architecture

- 2026-08-28 — **Supersedes the 2026-08-22 entries below.** One repo, two pnpm workspaces: `server-ts` (Node 22, no build step) and `frontend`. The Bun/Hono gateway, the Go product server, the pinned external agent runtime, Temporal and Valkey are all removed from the stack; compose is `berry-api` + `postgres` + `minio`. ADRs 0001, 0003, 0004, 0005 and 0007 were withdrawn with their subjects; 0008 and 0009 are the current architecture.
- 2026-08-22 — One repo, two independently tooled workspaces: `apps/gateway` (Bun + Hono + Biome) and `frontend` (Next.js + Prettier/ESLint). Documented in `docs/coding-playbook.md`.
- 2026-08-22 — ADR-0001 accepted: Bun + Hono gateway; browsers never call the substrate; product DTOs stay separate from Hono types (`docs/adr/0001-bun-hono-gateway.md`).
- 2026-08-22 — ADR-0002 accepted: Valkey for cache and ephemeral coordination; Postgres remains SoR. Valkey is not wired in gateway code yet (`docs/adr/0002-valkey-for-ephemeral-state.md`).
- 2026-08-22 — ADR-0003 accepted: pin the external agent runtime by immutable full commit SHA. Withdrawn on 2026-08-28 with its subject.
- 2026-08-22 — Local compose stack: the agent runtime on `:4200` (own SQLite volume), Postgres `127.0.0.1:5432`, Valkey `127.0.0.1:6379`. Weak-auth stores are loopback-only (`README.md`, `docker-compose.yml`).
- 2026-08-22 — Licensing: MIT/Apache-2.0 only; retain Circle notices; no third-party product branding (`docs/product-brief.md`).
- 2026-09-01 — ADR-0010 (goals as derived groups of a project's tasks) and ADR-0011 (refresh provider credentials) are both **Proposed**, not accepted. ADR-0011 is largely superseded in practice by the GitHub App work: installation tokens are minted on demand, so there is no user token to refresh.
