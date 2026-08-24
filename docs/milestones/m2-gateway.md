# M2 Gateway — milestone run report

| Field | Value |
| --- | --- |
| Milestone | M2 — Gateway: Bun/Hono BFF (Phase 1 core) |
| Tracking issue | BERR-3 |
| Report issue | BERR-51 |
| Date | 2026-08-22 |
| Integrated snapshot | `64b925f` (`main`) |
| Board state at report time | 9/9 child issues `done`; BERR-3 `in_review` |

## Delivered scope

| Issue | PR | Delivery |
| --- | --- | --- |
| BERR-19 | [#2] | Bun + Hono + TypeScript service scaffold, health route, Dockerfile, configuration, and graceful shutdown. |
| BERR-20 | [#21] | Typed OpenFang client with validation, retries, timeouts, normalized errors, and SSE parsing. |
| BERR-21 | [#1] | Berry-owned Postgres schema, migrations, constraints, and upgrade-path tests. |
| BERR-22 | [#17] | Shared Zod DTOs for resources, pagination, errors, and event envelopes. |
| BERR-23 | [#23] | Postgres-backed issue and comment CRUD, cursor pagination, and status-transition enforcement. |
| BERR-24 | [#18] | Session tokens, login/logout/me routes, auth middleware, roles, and migration `0002`. |
| BERR-25 | [#19] | Valkey cache-aside module, domain keys, invalidation helpers, timeouts, and circuit breaking. |
| BERR-26 | [#20] | Run-event SSE replay/live-follow transport and in-memory event store. |
| BERR-27 | [#22] | Pino request logs, W3C trace context, OpenTelemetry metrics, and `GET /metrics`. |

The milestone establishes the gateway's core modules and contracts. It does not deliver
the frontend integration or the issue-assignment-to-agent execution loop; those remain in
M3 and M4.

## Integrated test state

Checks below ran from `apps/gateway` on the integrated `64b925f` snapshot after
`bun install --frozen-lockfile`.

| Check | Result |
| --- | --- |
| `bun test` | **221 pass, 40 skip, 0 fail** across 261 tests. The skipped tests require `DATABASE_URL` and cover the integrated Postgres auth, issue/comment route, schema-constraint, and migration-upgrade paths. Live Valkey integration tests ran and passed against the reachable local service. |
| `bun run typecheck` | Pass (`tsc --noEmit`). |
| `bun run lint` | Pass; Biome checked 92 files with no fixes. |
| `bun run build` | Pass; Bun bundled 386 modules for the Bun target. |

The DB-backed suites were not rerun against a database for this report. Their feature PRs
record green isolated runs: PR #23 reports 69 passing tests against Postgres 16, and PR
#18 reports 30 passing / 1 skipped against Postgres 18.1. The current integrated head
therefore still needs one full Postgres-backed regression run before it can serve as a
release candidate.

The live OpenFang result remains the M1 smoke report: 8/11 groups passed against pinned
OpenFang `acf2587e` (`0.6.9`); chat completion, agent SSE completion, and workflow execution
failed because the configured `lmstudio` provider was unavailable. M2's adapter tests are
hermetic and pass, but this report does not claim a green model-backed end-to-end run.

## Known issues and integration gaps

These findings are present on the integrated snapshot. They are not fixed by this docs
change.

| Severity | Finding | Impact / next action |
| --- | --- | --- |
| High | `createApp()` initializes issue/comment route dependencies with `db: null`, while the production entry calls `createApp()` without injecting `getDb()`. | Issue and comment handlers return `503 DEPENDENCY_UNAVAILABLE` even when `DATABASE_URL` is configured. Wire the lazy production DB handle before M3 consumes these routes. |
| High | Issue/comment mutations still trust temporary `X-Berry-Actor-*` headers instead of BERR-24's bearer-session middleware. | Once DB wiring is restored, callers can assert actor/admin identity through headers. Replace the seam with resolved session identity before exposing the routes. |
| Medium | BERR-25's cache helpers and invalidation hooks are not called by the merged issue CRUD routes. | Valkey is tested as a module but does not currently accelerate or invalidate issue reads. Adopt it in the route/service layer before measuring hit rates. |
| Medium | The configured OpenFang client uses the default fetch path rather than BERR-27's `tracedFetch`. | Gateway trace context is not propagated through real adapter requests. Inject the traced fetch implementation in the configured client factory. |
| Expected deferral | The SSE route reads from an in-memory event store, but no dispatch/adapter producer feeds that store on the production path. | M4 (BERR-33 through BERR-35) owns assignment dispatch, run-state synchronization, and end-to-end progress streaming. |
| Expected deferral | Production passwordless login is deliberately disabled and no password/SSO provisioning path exists yet. | Authentication primitives are present, but production login needs the later identity/product-layer work before end-user use. |

No dedicated Berry issue existed for the four integration findings when this report was
written. They should be triaged before M3 starts; the high-severity findings block a usable
and safely authenticated issue API.

## Milestone assessment

M2 is complete at the child-delivery and module-test level: every planned component merged,
and the dependency-independent integrated checks are green. It is **not release-ready** and
should be treated as a gateway-core handoff with required integration follow-ups. In
particular, M3 should not assume the issue/comment API is usable until production DB and
session-auth wiring are corrected and exercised together.

[#1]: https://github.com/laravel42/berry-circle/pull/1
[#2]: https://github.com/laravel42/berry-circle/pull/2
[#17]: https://github.com/laravel42/berry-circle/pull/17
[#18]: https://github.com/laravel42/berry-circle/pull/18
[#19]: https://github.com/laravel42/berry-circle/pull/19
[#20]: https://github.com/laravel42/berry-circle/pull/20
[#21]: https://github.com/laravel42/berry-circle/pull/21
[#22]: https://github.com/laravel42/berry-circle/pull/22
[#23]: https://github.com/laravel42/berry-circle/pull/23
