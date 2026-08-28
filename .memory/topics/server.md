# Server

- 2026-08-28 — `server-ts` is the only server. It owns `migrations/` (forward-only, checksummed, advisory-locked) and applies them via `src/migrate` before boot; `src/seed` writes the development dataset after. Both idempotent, both run by compose.
- 2026-08-28 — Not served, answers 404: `/api/v1/runs`, `/workflows`, `/workflow-runs`, `/hooks`, `/approvals`, `/plans`, `/conversations`, `/integrations`, `/inbox`, `/search`, `/views`, `/catalogs`, `/runtime`, the multipart attachment upload, `/metrics`. See `server-ts/SCOPE.md`.
- 2026-08-28 — No run orchestration exists. `POST /internal/runs` (guarded by `BERRY_INTERNAL_TOKEN`) is the only way to start an agent, and nothing in the product calls it.
- 2026-08-28 — Runs `.ts` directly under `--experimental-strip-types`; `erasableSyntaxOnly` forbids enums, namespaces and parameter properties. No build step.
- 2026-08-28 — Wire shape is a contract: cursor envelopes and idempotency fingerprints already held by clients and stored in the database must keep decoding, so `http/cursor.ts` and `http/canonical-json.ts` are not free to change.
