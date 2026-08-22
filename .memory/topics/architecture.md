# Architecture

- 2026-08-22 — One repo, two independently tooled workspaces: `apps/gateway` (Bun + Hono + Biome) and `frontend` (Next.js + Prettier/ESLint). Documented in `docs/coding-playbook.md`.
- 2026-08-22 — ADR-0001 accepted: Bun + Hono gateway; browsers never call the substrate; product DTOs stay separate from Hono types (`docs/adr/0001-bun-hono-gateway.md`).
- 2026-08-22 — ADR-0002 accepted: Valkey for cache and ephemeral coordination; Postgres remains SoR. Valkey is not wired in gateway code yet (`docs/adr/0002-valkey-for-ephemeral-state.md`).
- 2026-08-22 — ADR-0003 accepted: pin OpenFang by immutable full commit SHA in `deploy/openfang.pin.json` (`docs/adr/0003-pin-openfang-by-commit.md`).
- 2026-08-22 — Local compose stack: OpenFang `:4200` (own SQLite volume), Postgres `127.0.0.1:5432`, Valkey `127.0.0.1:6379`. Weak-auth stores are loopback-only (`README.md`, `docker-compose.yml`).
- 2026-08-22 — Licensing: MIT/Apache-2.0 only; retain Circle and OpenFang notices; no Linear/OpenFang product branding (`docs/product-brief.md`).
