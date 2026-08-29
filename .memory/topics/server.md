# Server

- 2026-08-28 — `server-ts` is the only server. It owns `migrations/` (forward-only, checksummed, advisory-locked) and applies them via `src/migrate` before boot; `src/seed` writes the development dataset after. Both idempotent, both run by compose.
- 2026-08-29 — Everything the frontend calls is served. Still absent: `/runtime`, and the planner's `intent`/`context` stages. See `server-ts/SCOPE.md`.
- 2026-08-29 — Runs are dispatched in process by `runs/dispatcher.ts`: claim with `SKIP LOCKED`, hold and renew a lease (migration 035), execute, sweep the abandoned. The `/internal/runs` surface and its external worker are gone.
- 2026-08-28 — Runs `.ts` directly under `--experimental-strip-types`; `erasableSyntaxOnly` forbids enums, namespaces and parameter properties. No build step.
- 2026-08-28 — Wire shape is a contract: cursor envelopes and idempotency fingerprints already held by clients and stored in the database must keep decoding, so `http/cursor.ts` and `http/canonical-json.ts` are not free to change.
