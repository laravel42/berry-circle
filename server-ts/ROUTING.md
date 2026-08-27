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
| `/api/v1/projects` | 45 probes plus a full lifecycle; see the caveat below |
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

## The one known divergence: linking a GitHub repository

Berry stores a repository's id beside its name, and resolves that id through
GitHub rather than trusting the caller — a supplied id could name a repository
the connection cannot see, and the stored pair would then disagree about where
the project delivers. A database constraint keeps the two columns together.

This server has no resolver, so it refuses with **412
INTEGRATIONS_NOT_CONFIGURED** — which is Go's own answer for a deployment
without one. The running Go server *has* a resolver, so it refuses with **422
REPOSITORY_UNAVAILABLE** instead.

Both refuse, and neither writes a half-link, so no project can end up in a
broken state. But the codes differ, and a client that switches on them would
see the difference. No project in this deployment currently has a repository
linked, which is why projects are routed anyway.

## Agents: ported, with one deliberate difference

`GET /api/v1/agents` used to reconcile against the OpenFang runtime on **every**
request — `SyncWorkspace` before the listing was read, erroring rather than
degrading when the runtime was absent. The agent list was a live projection of
runtime state, not a table. Under `BERRY_AGENT_RUNTIME=adk` it is a table,
which is what let this mount move at all.

`GET /`, `GET /{id}` and `GET /capabilities` are **identical** to Go's, verified
by `contract-diff` against the same rows. Two routes are new, because a
rows-only agent needs them and a projected one never did:

| route | why it is new |
|---|---|
| `POST /` | agents were spawned in OpenFang and discovered by sync, so Berry has never had a way to author one |
| `DELETE /{id}` | archives; the protected orchestrator refuses with 409 `AGENT_PROTECTED` |

`PUT /{id}/config` keeps its request and response, and changes what it does.
Go pushed the configuration to OpenFang **before** storing it, so a save meant
the runtime had accepted it. There is no upstream now, so storing it *is* the
operation — and the model is written to the row, which Go never did: it read
the model back from OpenFang after pushing it. A save that did not store it
would silently do nothing.

`POST /{id}/ask` stays on Go and is not routed here. It is a chat completion
through OpenFang, nothing in the product calls it, and what it should mean
under ADK is a separate decision from moving the mount.

### `GET /models` differs on purpose

This is the one route where the two servers answer differently, and the
difference is the point.

| | |
|---|---|
| Go | 458 models: 417 from OpenRouter, plus 41 compiled into the OpenFang binary for `anthropic`, `codex`, `groq`, `ollama`, `openai`, `lmstudio`, `vllm` |
| TypeScript | 417 models, all OpenRouter's |

Berry's ADK runtime has exactly one model client, and it talks to OpenRouter.
An agent pointed at `anthropic/claude-sonnet-4-6` — a real entry in Go's list —
would fail on its next task, because OpenRouter has never heard of that id.
Go's catalogue is now *wrong* for this deployment: it offers models that cannot
run. Every stored pairing in the database is already `openrouter/…`, so nothing
depends on the dropped providers.

The prefix-stripping quirk is kept (`openrouter/anthropic/claude-sonnet-4` →
`anthropic/claude-sonnet-4`), because stored pairings still carry it and
dropping it would make every one of them read as unavailable.

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

## Running the database-backed tests

The ledger and artifact tests need a real PostgreSQL, because everything they
are for happens in the database: the sequence is allocated by a SQL function,
the ordering guarantee is microsecond arithmetic PostgreSQL performs, and the
jsonb column is where a wrongly-encoded envelope stops looking wrong.

They run against their own database rather than the development one. Not
fastidiousness: creating a workspace fires a trigger that provisions a
**protected** Orchestrator agent, and a protected agent refuses both deletion
and unprotection — so a fixture in the development database leaks a workspace
on every run and cannot tidy up after itself.

```
docker compose exec -T postgres sh -c \
  'createdb -U berry berry_test; pg_dump -U berry --schema-only --no-owner \
     --no-privileges berry | psql -U berry -d berry_test -q'

docker run -d --rm --name berry-pg-bridge --network berry-stack_default \
  -p 15432:15432 alpine/socat tcp-listen:15432,fork,reuseaddr tcp:postgres:5432

BERRY_TEST_DATABASE_URL='postgres://berry:berry@127.0.0.1:15432/berry_test?sslmode=disable' \
  npm test
```

Without the variable the suite skips them and still passes, so `npm test` works
on a machine with no stack running.

## The rule

A prefix moves when `contract-diff` reports `identical` or `identical apart from
request ids and timestamps` for every path under it, against the same database.
Anything else means the two servers would answer the same question differently,
which is the one thing the strangler cannot survive.
