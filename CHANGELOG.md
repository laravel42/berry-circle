# Changelog

All notable changes to Berry are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). See
[docs/changelog-process.md](docs/changelog-process.md) for how entries are written and
how releases are cut.

## [Unreleased]

No version has been tagged yet — Berry is pre-release. The first tagged release is cut at
milestone **M6 (Release 1)**; until then all shipped work accumulates here. This first
entry covers everything merged to `main` as of 2026-08-22, spanning the foundation
docs/knowledge base (**M0**), the OpenFang integration proof (**M1**, in progress), and
the initial gateway service groundwork.

### Added

- Product brief — what Berry is, who it is for, the issue → agent → review product motion,
  Release 1 scope (web app only), and the licensing posture — BERR-9 ([cd882f4]).
- OpenFang integration spec mapping Berry features to OpenFang endpoints
  (`docs/integrations/berry-openfang.md`) — BERR-10 ([#5]).
- Gateway API contract v1 (`docs/api/gateway-v1.md`), the Linear-shaped surface the
  gateway will expose — BERR-11 ([#7]).
- Architecture Decision Record log with the first decisions: ADR-0001 (Bun + Hono
  gateway), ADR-0002 (Valkey for ephemeral state), and ADR-0003 (pin OpenFang by
  commit) — BERR-12 ([#8]).
- Coding playbook documenting repo conventions grounded in the codebase: the
  two-workspace toolchain split (Biome gateway vs Prettier/ESLint frontend), TypeScript
  style, the Zod boundary-validation pattern, the central Hono error envelope, `bun:test`
  conventions, and the branch/PR review-gate workflow — BERR-13 ([#9]).
- Design-system baseline defining Berry's UX tokens for the frontend
  (`docs/design-system.md`) — BERR-14 ([#6]).
- OpenFang gateway consumption contract enumerating the endpoints the gateway depends on
  (`docs/api/openfang-gateway-consumption.md`) — BERR-17 ([#10]).
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
- Local stack — `docker-compose.yml` standing up OpenFang, Postgres, and Valkey. OpenFang
  is built from an immutable pinned commit (`deploy/openfang.pin.json`, `acf2587e`, per
  ADR-0003) via a BuildKit git context; includes a boot-from-clean guide in the
  README — BERR-15 ([#13]).
- OpenFang integration smoke test exercising the live agent/workflow API end to end, with
  fault-isolated resource cleanup, abort-timeout hardening on body reads, and assertions
  on `usage.input_tokens` / `usage.output_tokens` (the Berry token-total dependency) —
  BERR-18 ([#12]).

### Fixed

- Migration upgrade-path test suite (`apps/gateway/src/db/migrate.upgrade.test.ts`) now
  loads and skips cleanly on a fresh checkout without `DATABASE_URL`. The admin connection
  URL is deferred to call time so `describe.skip` no longer constructs `new URL("")` at
  test registration — BERR-50 ([#11]).

### Security

- Docker Compose binds the published Postgres (`5432`) and Valkey (`6379`) ports to
  `127.0.0.1`, so the weak-/no-auth local-dev services are reachable from the host (and the
  host-run gateway) but never from the LAN. The README documents that `OPENFANG_API_KEY`
  must be set before exposing the host on an untrusted network — BERR-15 ([#13]).

[Unreleased]: https://github.com/laravel42/berry-circle/commits/main
[cd882f4]: https://github.com/laravel42/berry-circle/commit/cd882f4
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
