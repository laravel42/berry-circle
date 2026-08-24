# OpenFang integration

- 2026-08-22 — Pin is `acf2587e46be174c10200489c9a2d23a39a98aeb` in `deploy/openfang.pin.json`. Upgrade must move pin, compose `OPENFANG_COMMIT`, and contracts together.
- 2026-08-22 — Berry-native issues, projects, cycles, comments, roles, and review gates have no OpenFang mapping; they stay in Postgres (`docs/integrations/berry-openfang.md`).
- 2026-08-22 — GAP: no durable issue-correlated run resource. Berry mints run IDs and persists the ledger. Do not auto-retry POST dispatch or re-POST SSE after disconnect.
- 2026-08-22 — GAP: memory KV handlers ignore `{id}` (prefix keys). Workflow-runs list ignores `{id}`. No SSE resume cursor.
- 2026-08-22 — Gateway always sends `Authorization: Bearer` when configured; never return the key to browsers. Field-level contract: `docs/api/openfang-gateway-consumption.md`.
- 2026-08-22 — Live smoke test: `apps/gateway/tests/openfang-smoke.ts` (`bun run test:smoke:openfang`).
- 2026-08-22 — Local OpenFang on `:4200` accepted a Berry run, then closed the SSE after `phase` because its configured LLM credential was rejected.
