# What may be routed to the TypeScript server

The frontend reaches the API through `frontend/next.config.ts`, which rewrites
`/api/:path*` to one origin. The migration moves prefixes across one at a time,
so this file records which are ready and — more importantly — why the others
are not. A prefix answered by both servers is only safe to move when the
responses agree; "it returns 200" is not the bar.

Check with `scripts/contract-diff.ts` against both servers pointed at the **same
database**, or the drift you see is data, not contract. It compares headers as
well as bodies: this server once answered every path with a byte-identical body
and no Content-Security-Policy at all, and a body-only diff called that a pass.

## Ready

| Prefix | Verified |
|---|---|
| `/health` | byte-identical |
| `/api/v1/me` | 33 probes — reads, writes, validation edges — body, status and headers |
| `/api/v1/workspaces` | 35 probes, including pagination, authorization and the last-owner rule |
| the error envelope | byte-identical for 401 and 404, request id aside |

Timestamps written by this server carry millisecond precision where Go's carry
microseconds, because Node's clock stops there. Ordering is unaffected — the
`(created_at, id)` cursor breaks ties on the id — but two rows created in the
same millisecond share a `created_at` here where Go would separate them.

## Not ready, and what blocks each

| Prefix | Blocked on |
|---|---|
| `/ready`, `/readyz` | Go probes `database`, `realtime`, `triggerdispatch` and `valkey`; this server has only `database`. Routing it would report a narrower readiness than the deployment actually has, and an orchestrator would believe it. |
| `/metrics` | Go serves Prometheus text and metrics are **enabled** in the running deployment. This server returns 404, so scraping would silently stop. Lands with the observability port. |
| `/api/v1/config` | `capabilities` tells the browser which features to render. This server can only honestly report `metrics` and would switch off agent execution, planner, workflows, storage, realtime and valkey in the UI. Moves when those subsystems do. |
| `/api/v1/auth` | ported and tested, but session issuance writing from two servers has not been exercised under load. |

## The rule

A prefix moves when `contract-diff` reports `identical` or `identical apart from
request ids and timestamps` for every path under it, against the same database.
Anything else means the two servers would answer the same question differently,
which is the one thing the strangler cannot survive.
