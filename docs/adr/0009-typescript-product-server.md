# ADR-0009: Reimplement the product server in TypeScript

- **Status:** Accepted — the Go server was removed on 2026-08-28 and this is
  the only server. It is not feature-complete; `server-ts/SCOPE.md` records what
  is missing.
- **Date:** 2026-08-27
- **Deciders:** Berry platform
- **Supersedes:** ADR-0004 (Go product server), withdrawn with its subject
- **Related:** [ADR-0008](0008-adk-agent-runtime.md) (ADK agent runtime),
  [Multica reuse provenance](../provenance/multica-server-reuse.md)

## Context

Berry's server is 85,970 lines of production Go. The person directing Berry's
development does not read Go.

That is not a matter of taste. It means the owner cannot review a change, verify
a claim about behaviour, or maintain the product without an intermediary — and
in practice every change this month has gone through one. A codebase its owner
cannot read is a codebase they cannot be responsible for.

This reverses ADR-0004 (withdrawn), taken five days ago on
2026-08-22, which moved Berry from a Bun/Hono gateway to Go in order to absorb
owner-authorised Multica Go product material. That rationale is not disputed;
it is outweighed.

**Provenance permits it.** The [reuse record](../provenance/multica-server-reuse.md)
carries two rows, and both state that what landed was "Berry-native
implementation informed by the named behavioral patterns; no legacy source
copied". No Multica source sits in Berry's server, so reimplementing Berry's own
code in another language is not an import and needs no new row. The owner
authorised reuse, adaptation and relicensing in any case.

It is taken together with [ADR-0008](0008-adk-agent-runtime.md) deliberately.
Roughly 4,000 lines exist only to talk to OpenFang; migrating first would mean
porting all of it and then deleting it.

## Decision

Reimplement the product server in TypeScript, strangling it through the
frontend's existing proxy rather than cutting over at once.

`frontend/next.config.ts` already rewrites `/api/:path*` to a configurable
origin, and `internal/httpapi/router.go` enforces **disjoint prefix mounts**.
Those two facts together are the migration strategy: prefixes move one at a
time, both servers against one database, Berry usable throughout. A single
cutover of 86,000 lines is not survivable — when it breaks, nothing
distinguishes a porting error from an ADK error from a workflow error.

**Temporal stays.** ADK's `loopagent` composes one agent's turn in one process;
Berry's Temporal use is durable across restarts and days — signal-driven
cancellation reaching a live stream, resume signals for approvals that wait,
schedules with catch-up windows, and `ContinueAsNew` bounding the intake loop.
`@temporalio/*` exists and the shape ports (see below).

**Migrations do not move.** The same `.up.sql` files, the same
`berry_schema_migrations` table, the same SHA-256 checksums and advisory lock.
One schema, two servers; this is what makes the strangler safe.

## What was verified before proposing this

Three unknowns could each have ended the migration. All were built and run.

**1. ADK JS has no OpenAI-compatible model.** `@google/adk` v2.0.0 ships
`google_llm.ts` and `apigee_llm.ts` over an extensible `base_llm.ts` — and
nothing else. (ADK **Go** has `model/openaimodel`, verified working against
OpenRouter. JS does not.) Berry must own an OpenRouter model, about 290 lines
subclassing `BaseLlm`. Proven: 19 streamed deltas, a tool call round-tripped and
executed, token usage on every turn.

The spike earned its cost immediately. ADK builds tool parameters from zod and
renders them in Gemini's schema dialect — `{"type": "OBJECT"}`, `{"type":
"STRING"}` in capitals. OpenAI-compatible endpoints require lower case, and
OpenRouter answers an uppercase schema with `400 Provider returned error`,
naming no field. Found in an afternoon; it would have surfaced during Stage 5 as
"agents cannot use tools".

**2. Temporal's determinism shape ports.** `RunOrchestration` was ported whole.
Go's `workflow.NewSelector` over a future and a signal channel has no TypeScript
equivalent; the working translation is `CancellationScope.cancellable` holding
the dispatch, `condition()` on the signal, `Promise.race` between them, and
`CancellationScope.nonCancellable` around both the upstream stop and the ledger
tail — otherwise cancelling the scope kills the activities that record why the
run stopped. Verified order under a real Temporal test server:

```
dispatchRun → cancelRun:user-42 → promote → deliver → autoReview → dispatchRun:cancelled
```

The stop is claimed before the stream is released, and every best-effort ledger
activity still runs on a cancelled run.

Second finding: **Go's compound duration strings do not survive.**
`startToCloseTimeout: '2h5m'` throws inside `msToTs` at activity-schedule time,
because Temporal TS parses durations with `ms`, which takes `'125m'` but not
`'2h5m'`. Every duration in `internal/orchestration/orchestration.go` needs
checking during the port.

**3. Berry's SSE contract survives Node.** Cursor replay delivers only what a
reconnecting client missed; an idle stream heartbeats; and a slow consumer is
**dropped rather than buffered**. The last is the one at risk: Go does a
non-blocking send into a bounded channel and deletes the subscriber when it is
full, and Node has neither primitive — left alone it queues in the socket write
buffer without limit, so one client that stops reading grows the server until it
falls over. Reproduced with an explicit bounded queue: dropped after 64 queued,
matching `REALTIME_BUFFER`.

## Consequences

### What this costs

85,970 production lines and 32,699 lines of tests. `internal/handlers` (27k) and
`internal/repository` (24.6k) are 58% of it and both are mechanical — routes and
SQL, and the SQL transfers almost literally since it is hand-written and
hand-scanned already.

**There is no OpenAPI spec.** [`docs/api/gateway-v1.md`](../api/gateway-v1.md)
covers ~74 of 131 route registrations in prose and explicitly disclaims several
surfaces as "treat the implementation as authoritative". For most of the API the
Go code *is* the contract, so tests port alongside their handlers — they encode
behaviour the document does not.

New dependencies where Go used the standard library: an HTTP framework, a
Postgres driver, a validation library, a logger. `@google/adk` alone pulls 17
dependencies including `@mikro-orm/core`; it is Apache-2.0, which satisfies
Berry's MIT/Apache-2.0-only rule.

### What this buys

The owner can read, review and change the product. Beyond that: 113 hand-written
zod schemas on the frontend currently mirror ~205 Go wire structs with nothing
keeping them in step, and one language lets the schema be the source and the
type be inferred from it.

### What is deliberately unchanged

The public contract. `/api/v1`, the error envelope, cursor pagination,
`Idempotency-Key`, opaque session tokens and `berry_pat_` personal access
tokens all keep their exact shapes — the frontend parses them today and the
strangler requires both servers to be indistinguishable to it.

## Alternatives considered

- **Stay on Go.** Cheapest by far, and correct if anyone else were maintaining
  it. Rejected on the one ground that matters here.
- **Migrate first, ADK after.** Ports ~4,000 lines of OpenFang plumbing and then
  deletes them, and leaves every agent defect in ADR-0008 standing for weeks.
- **ADK first, migrate after.** Lower risk — ADK Go is proven and needs no
  hand-written model — but does the ADK integration twice.
- **Big-bang cutover.** Rejected: no way to attribute a failure to the port, the
  runtime, the model adapter or a ported workflow.
