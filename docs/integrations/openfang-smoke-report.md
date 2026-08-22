# OpenFang integration smoke-test report

Date: 2026-08-22

Pinned upstream revision: `acf2587e46be174c10200489c9a2d23a39a98aeb` (`0.6.9`)

Command: `cd apps/gateway && bun run test:smoke:openfang`

## Scope

The smoke runner checks the OpenFang surfaces Berry maps in
`berry-openfang.md`: health, agent lifecycle, KV memory, workflow lifecycle,
model discovery, chat completions, agent SSE, workflow execution/history,
session evidence, audit evidence, and usage evidence. Test resources have a
unique `berry-smoke-*` name and are deleted at the end of the run.

If `/api/health` is unavailable, set `OPENFANG_SMOKE_COMPOSE_FILE` to the pinned
Compose file. The runner invokes `docker compose -f <file> up -d --wait` before
testing. `OPENFANG_BASE_URL`, `OPENFANG_API_KEY`, `OPENFANG_SMOKE_PROVIDER`,
`OPENFANG_SMOKE_MODEL`, and the timeout variables can override local defaults.

## Result

The API process at `http://127.0.0.1:4200` reported version `0.6.9`. The live run
passed 7 of 11 groups: health, memory lifecycle, workflow lifecycle, model
discovery, stop, session/audit/usage, and cleanup.

Four groups failed:

- Agent update returned `422` because the pinned API requires
  `manifest_toml`, contrary to the documented partial-update body (BERR-49).
- Chat completion returned `500` because the configured `lmstudio` provider
  targeted `http://localhost:1234/v1/chat/completions`, where no model server
  was available.
- SSE emitted a failure `phase` event and ended without `done` for the same
  provider outage.
- Workflow execution returned `500` for the same provider outage.

Provider readiness is covered by BERR-16; those checks intentionally fail
instead of being counted as skips.

The authoritative pass/fail count and per-check diagnostics are emitted by the
runner on each environment. A run is successful only when every check passes;
skipped provider checks are not treated as success.

## Residual risk

- The stop route's idle/no-active-run response is covered. Cancellation during
  live inference still requires a model-backed follow-up because coordinating
  it without a test hook would be timing-dependent.
- Authentication failure behavior requires a stack configured with an API key;
  this local process did not require one.
- The Compose boot path could not execute in this run because the sibling stack
  definition had not landed and the local Docker daemon was unavailable. The
  runner fails explicitly when boot is needed and no Compose file is supplied.
