# What may be routed to the TypeScript server

The frontend reaches the API through `frontend/next.config.ts`. It sends
everything to Go unless `BERRY_TS_API_ORIGIN` is set, and then moves only the
prefixes in that file's `TYPESCRIPT_ROUTES` list. The migration moves prefixes
across one at a time, so this file records which are ready and — more
importantly — why the others are not. A prefix answered by both servers is only
safe to move when the responses agree; "it returns 200" is not the bar.

See `SCOPE.md` for the sections that are not being migrated at all.

## Turning it on

```
BERRY_TS_API_ORIGIN=http://127.0.0.1:4100
```

**The TypeScript server must be running.** With the variable set and nothing
listening, the routed prefixes fail — the proxy does not fall back to Go, and a
silent fallback would be worse: it would hide an outage behind a working app.
Unset the variable to put everything back on Go.

The patterns are narrow on purpose. `/api/v1/issues/:issueRef` matches one
segment, so `/api/v1/issues/BER-1/comments` falls through to Go — the only
server that has comments. A `:path*` there would 404 every nested route.

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
| `/api/v1/tokens` | create/replay/conflict compared per server; issued secrets authenticate against both |
| `/api/v1/invitations` | 44 probes, plus 17 addresses at the email-validation boundary |
| `/api/v1/boards` | 31 probes, including the column-in-use guard in both directions |
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
| `/api/v1/issues` | **reads only.** `GET /` and `GET /:issueRef` are verified across 38 probes, and cursors cross between the servers in both directions. Creating and updating an issue publishes to the realtime hub; a mount that wrote correctly but published nothing would leave every open board silently stale, so those routes wait for the hub rather than shipping with a no-op broadcaster. |

## Comparing a create

Both servers share a database, so a create cannot simply be sent to both.

With the **same** `Idempotency-Key`, the first server creates and the second
correctly *replays* — same id, no secret, `Idempotency-Replayed: true`. That is
the mechanism working, and the matching ids are the proof.

With `distinctKeys: true`, each server executes for real — which is what you
want, until the resource has a uniqueness rule of its own. An invitation is
unique per pending address, so the second server then conflicts legitimately.

Neither mode compares such an endpoint cleanly. Verify those per server, one
request each against a reset table, as the invitation and token checks do.

## What issues still needs

| | |
|---|---|
| ~~the realtime hub~~ | ported: hub, relay and the distributed broadcaster |
| goal linking | `applyGoalChange` when a create or patch names a goal |
| assignee validation | that the actor exists *in this workspace* |
| the approval boundary | `ErrApprovalRequired` on a gated board |

The realtime port is verified against Go in both directions on a live Valkey
stream, but nothing is wired into a mount yet — no route publishes and no SSE
endpoint subscribes. Those land with the issue write path and the `runs` and
`events` mounts.

## A second shadowed port

The container's Valkey publishes to `127.0.0.1:6379`, and a **host Redis
listens there too** — exactly like the PostgreSQL collision. A relay pointed at
6379 from the host reads an empty stream and reports nothing wrong. Bridge it
the same way:

```
docker run -d --rm --name berry-valkey-bridge --network berry-stack_default \
  -p 56379:6379 alpine/socat tcp-listen:6379,fork,reuseaddr tcp:valkey:6379
```

## The rule

A prefix moves when `contract-diff` reports `identical` or `identical apart from
request ids and timestamps` for every path under it, against the same database.
Anything else means the two servers would answer the same question differently,
which is the one thing the strangler cannot survive.
