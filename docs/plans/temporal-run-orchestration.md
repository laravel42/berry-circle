# Plan: Temporal for Berry run orchestration

- **Status:** Direction chosen — Temporal. Multi-step / multi-agent
  orchestration is confirmed on the roadmap (2026-08-23), which decides the
  open question this plan was blocked on. ADR-0005 pending.
- **Date:** 2026-08-23
- **Target:** `server/` (Go product server) only
- **Related:** [ADR-0004](../adr/0004-go-product-server.md),
  [ADR-0002](../adr/0002-valkey-for-ephemeral-state.md),
  [ADR-0003](../adr/0003-pin-openfang-by-commit.md),
  [OpenFang integration spec](../integrations/berry-openfang.md),
  [gateway v1 contract](../api/gateway-v1.md)

## Why this is on the table

Berry's run dispatch path is durable in storage but **not durable in
execution**. The ledger is correct; the thing that drives the ledger forward
is a process-local Go channel.

`server/internal/service/runadmission/service.go` runs a bounded in-process
worker pool (`jobs chan uuid.UUID`, 4 workers, queue of 128). The admission
handler hands work to it fire-and-forget:

```go
// server/internal/handlers/runs/admission.go:207
_ = handlers.service.Queue(run.ID)
```

The error is deliberately discarded — acceptance must not 503 after the run
row is committed. That is the right HTTP behavior and the wrong durability
story, because nothing else will ever pick the run up.

Concretely, on an API restart, deploy, OOM, or node loss:

| Run state at crash | What happens today |
|---|---|
| `queued` / `dispatch_state = pending` | Never dispatched. Sits in `queued` forever. |
| `dispatch_state = dispatching` | Orphaned. No terminal transition, no reconciliation. |
| `dispatch_state = streaming` | Orphaned mid-stream. Persisted events stop; the run never completes. |
| `dispatch_state = reconciliation_required` | Written correctly, and **nothing ever reconciles it**. |

The schema already anticipates the missing component. `migrations/003_agents_and_run_admission.up.sql`
creates `runs_dispatch_pending_idx` and `runs_reconciliation_idx` — indexes
whose only purpose is to feed a sweeper that does not exist. The state machine
in `internal/repository/runs/transitions.go` is complete; the driver is not.

**The question this plan answers:** should that driver be a hand-written
Postgres-leased sweeper, or Temporal?

## What Temporal actually buys — and what it does not

Being honest about this matters, because OpenFang's contract limits the
upside.

**It buys:**

1. **Durable queued → dispatching handoff.** A run that is admitted is
   guaranteed to be attempted, across restarts. This is the single largest
   correctness win and it is unavailable today at any price short of building
   a leased sweeper.
2. **Crash detection instead of orphaning.** Heartbeat timeout converts a
   dead worker into a *defined* transition to `reconciliation_required`,
   rather than a row that is silently stuck forever.
3. **A real reconciliation loop.** A Temporal Schedule drains
   `reconciliation_required` and stale `dispatching` / `streaming` rows on a
   cadence, with retries, backoff, and visibility.
4. **Cancellation that survives a restart.** Cancel becomes a signal to the
   workflow that owns the stream, not an HTTP call racing an in-process
   goroutine.
5. **Operational visibility.** Every stuck run is a queryable workflow with
   its full history, instead of a Postgres row plus a guess.

**It does not buy:**

- **Stream resumption.** OpenFang has no SSE resume cursor and re-POSTing
  duplicates agent execution (`docs/integrations/berry-openfang.md`). A
  crashed stream is still a lost stream. Temporal makes the loss *visible and
  terminal*; it cannot make it recoverable. Any plan claiming otherwise is
  wrong.
- **Exactly-once dispatch.** That is already correct, via the
  `dispatch_version` optimistic lock in `ClaimDispatch`. Temporal's workflow-ID
  dedup is a useful second layer, not the primary guarantee.

## Hard constraint: at-most-once POST

This is the invariant most likely to be broken by a naive Temporal
integration, so it goes first.

`server/internal/openfang/transport.go:161` states it directly:

> Unsafe POST dispatch is attempted exactly once.

Temporal activities retry **by default**. An activity that wraps
`POST /api/agents/{id}/message/stream` with a default `RetryPolicy` will
re-dispatch on any transient failure and run the agent twice — burning tokens,
duplicating tool side effects, and violating the pinned integration contract.

Non-negotiable rules for the dispatch activity:

- `RetryPolicy{ MaximumAttempts: 1 }`. Explicit, asserted in a unit test.
- The activity is `dispatchAndStream` — a single activity that POSTs **and**
  consumes the stream. Splitting them is not possible: the stream *is* the
  POST response body.
- Heartbeat timeout on that activity resolves to
  `reconciliation_required`, never to a retry.
- Only genuinely safe operations (`StopAgent`, ledger writes, reads) get a
  retrying policy.

The existing `RetryClass` taxonomy (`RetryRead` / `RetryIdempotentWrite` /
`RetryUnsafe`) maps one-to-one onto activity retry policies. Reuse it rather
than inventing a parallel classification.

## Boundaries this plan does not cross

- **Postgres stays the system of record.** Temporal is a durable *executor*.
  The run ledger, `run_events`, and the replay cursor stay authoritative for
  every API read. Temporal history is never read to answer an API request.
- **OpenFang stays the sole agent-execution substrate.** ADR-0004 reserves
  "agent execution, sandboxing, scheduling, model/provider access" to
  OpenFang. Temporal schedules *Berry's product-side orchestration*, not agent
  execution. **This distinction must be written explicitly into the ADR**, or
  review will read it as a boundary violation.
- **The public contract does not change.** `/api/v1`, the error envelope,
  cursor pagination, `Idempotency-Key`, SSE framing — all unchanged. Adding
  Temporal must be invisible at the wire.
- **Browsers still call Berry only.** Temporal has no browser-facing surface,
  and no Temporal Web UI is exposed in a default self-hosted deployment.
- **`apps/gateway` is untouched.** It is the compatibility oracle and is
  deleted at cutover (ADR-0004). Adding Temporal there would create a second
  authoritative writer — explicitly forbidden.
- **Naming.** OpenFang has its own `workflows` API, and AGENTS.md forbids
  OpenFang-derived identifiers. Do **not** name the package `workflow`. Use
  `internal/orchestration`, with types like `RunOrchestration`. A reviewer
  must never have to ask which kind of workflow a symbol means.

## Target architecture

```
POST /api/v1/.../runs
  └─ handlers/runs/admission.go
       ├─ store.Admit(...)                     ← unchanged, durable acceptance
       └─ temporal.StartWorkflow(RunOrchestration, runID)
            WorkflowID: "run:" + runID          ← dedup key
            IDConflictPolicy: UseExisting

RunOrchestration(runID)                        ← replaces the jobs channel
  ├─ activity ClaimDispatch          retry: safe
  ├─ activity DispatchAndStream      retry: MaximumAttempts=1, heartbeats
  │     └─ persists events via the existing Store, publishes via Broadcaster
  ├─ signal  CancelRun               → activity StopAgent (retry: safe)
  └─ on heartbeat timeout / activity failure
        └─ activity MarkReconciliationRequired  retry: safe

ReconciliationSchedule (every 60s)
  └─ ReconcileStaleRuns              ← drains the two indexes that exist today
```

**The seam already exists.** `runadmission.Options` takes `Store`,
`OpenFang`, `Broadcaster`, `Clock`, `NewID` as explicit interfaces, and
`Store` is a 14-method interface over the durable ledger
(`service.go:31–45`). Activities call those same methods. This is why the
integration is tractable: no repository rewrite, no schema migration for the
happy path.

`internal/openfang.Runtime` and `internal/realtime.Broadcaster` are likewise
already interfaces. Activities are thin adapters over code that exists.

## Multi-step / multi-agent: what the roadmap answer changes

This is no longer an optional Phase 5. It is a driver, and it collides with
the current schema in a way that must be designed before Phase 2 cements
assumptions.

### The invariant: one code-editing agent per issue at a time

Stated by the product owner, 2026-08-23:

> One issue can have multiple agents assigned, but only one at a time should
> edit code, otherwise they create race conditions and code inconsistency.

This is the constraint the design must protect, and it makes the schema
change **smaller** than first assessed. `migrations/002_runs.up.sql` already
enforces it — by accident, and too broadly:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS runs_one_active_per_issue_key
    ON runs (issue_id)
    WHERE status IN ('queued', 'running');
```

That index says *one active run per issue*. The invariant we actually want is
*one active **code-editing** run per issue*. Reviewing, analysing, planning,
and summarising touch no working tree and can safely run concurrently.

So the index is not removed. It is **narrowed**.

### Run modes

Add a mode to `runs` distinguishing what a run is allowed to touch:

| Mode | Can edit the working tree | Concurrency |
|---|---|---|
| `write` | yes | at most one active per issue |
| `read` | no | unbounded (subject to a budget cap) |

```sql
-- migration 009
CREATE TYPE run_mode AS ENUM ('write', 'read');
ALTER TABLE runs ADD COLUMN mode run_mode NOT NULL DEFAULT 'write';

DROP INDEX runs_one_active_per_issue_key;
CREATE UNIQUE INDEX runs_one_active_writer_per_issue_key
    ON runs (issue_id)
    WHERE status IN ('queued', 'running') AND mode = 'write';
```

`DEFAULT 'write'` makes every existing row keep exactly today's behavior, so
the migration is behavior-preserving by construction.

### Why this is a much safer change than the original plan said

The earlier draft proposed replacing the per-issue guard with a per-*group*
guard. That would have relaxed the very constraint the product needs, and it
would have rewritten the redispatch protection `admission.go` depends on. The
narrowed index is better on both counts: single-agent behavior is untouched,
and the guard keeps its shape.

Consequences for the four load-bearing layers:

| Layer | Where | Change |
|---|---|---|
| Storage | `runs_one_active_per_issue_key` | Narrowed to `mode = 'write'` |
| Admission | `runs.ActiveRunError` (`models.go:203`) | Raised only for `write` admissions; rename to `ActiveWriterError` |
| Denormalization | `issues.active_run_id`, `core/models.go:106` | Keeps its meaning — the active **writer** |
| **Public contract** | `activeRunId` in `runs/events.go:214` | **Unchanged.** Still the active writer. |

`activeRunId` surviving intact means **this is no longer a breaking contract
change.** `gateway-v1.md` gains the `mode` field and a way to list concurrent
read runs; it does not have to deprecate anything.

### Defence in depth

The database index is the backstop, not the mechanism. Two independent layers
protect the invariant:

1. **The parent workflow serialises writes by construction.**
   `RunGroupOrchestration` never starts two `write` children concurrently.
   Read children fan out freely. This is deterministic workflow logic, so a
   violation is a code bug visible in review, not a race.
2. **The partial unique index rejects it anyway.** If the workflow logic is
   ever wrong, admission fails loudly instead of corrupting a working tree.

Belt and braces is warranted here: the failure mode is silent code corruption
across two agents, which is expensive to detect and worse to debug.

### Still needed: the run group

Groups are still required — they hold plan-level state that belongs to no
single run:

- `run_groups` table; `runs.group_id` FK. A single-agent run is a group of
  one, so there is one code path rather than two.
- Group-level status, current step, and the token budget cap for the whole
  plan.
- Group-scoped cancellation: cancelling a plan must cancel its children.

The group does **not** own the write lock. The issue does. That separation is
what keeps the migration small.

### Temporal shape

```
RunGroupOrchestration(groupID)              ← parent workflow
  ├─ step 1  WRITE  ExecuteChildWorkflow(RunOrchestration, runID₁)
  │                 .Get(ctx, ...)            ← awaited: never concurrent
  ├─ step 2  READ   fan out ─┬─ child RunOrchestration(runID₂)  review
  │                          └─ child RunOrchestration(runID₃)  review
  │                             bounded by workflow.NewSelector + a cap
  ├─ step 3  WRITE  ExecuteChildWorkflow(RunOrchestration, runID₄)
  │                 .Get(ctx, ...)            ← awaited again
  ├─ human review gate: workflow.GetSignalChannel(ctx, "ReviewDecision")
  │                      .Receive(ctx, &decision)   ← blocks for days, durably
  └─ ParentClosePolicy: WaitAllCompletedPolicy

Write steps are awaited. Read steps fan out. The rule is one line of workflow
code, and the database proves it held.
```

`RunOrchestration` from Phase 2 becomes the child unchanged. That is the
payoff for building it as a standalone workflow first.

### The human review gate is the strongest argument here

Berry's core loop is *issue → assign → work → **human review gate** → done*,
and the release gate is always human (AGENTS.md). A workflow that blocks on
`Receive` for a signal that may not arrive for days — surviving deploys,
restarts, and node loss, with no polling and no timer table — is the thing
Temporal is unambiguously best at. On a sweeper, "wait for a human" is a
state column plus a cron plus a bug.

### Constraints this adds

- **Determinism.** Workflow code cannot read the clock, generate UUIDs, or
  hit the network directly. `RunGroupOrchestration` will change shape as the
  product evolves while executions are in flight, so `workflow.GetVersion`
  discipline is required from the first commit, not retrofitted. Note that
  `runadmission.Options` already injects `Clock` and `NewID` — that pattern
  carries over cleanly into activities.
- **Cost fan-out.** Three agents in parallel is three times the token spend
  with no natural backpressure. A concurrency cap and a per-group budget
  guard belong in the design, not in a follow-up incident.
- **Failure policy per step.** "Step 3 of 7 failed" needs a defined answer:
  fail the group, continue, or pause for a human. This is a product decision
  and should be written down before it is inferred from code.

## Deployment shape

Add to `docker-compose.yml`:

- `temporal` — server, pointed at the **existing** Postgres container using
  separate `temporal` / `temporal_visibility` databases. One fewer container
  than the usual auto-setup topology, and it keeps the self-hosted story
  intact (ADR-0004: "self-hosted deployments complete without requiring
  Berry-hosted services").
- Temporal Web UI: **off by default**, behind an opt-in env flag.

Worker placement — recommend a separate `cmd/worker` binary:

- The API can restart without killing in-flight streams held by workers.
- Workers scale on stream concurrency; the API scales on request rate.
- Cost: a second binary, a second Dockerfile target, a second deploy unit.

Both binaries share `internal/`, so the code cost is small. Start with the
worker embedded in `cmd/api` behind a flag if you want to defer the
operational split — but design the package boundary for separation from day
one.

## Phases

Each phase is independently mergeable and independently revertible.

### Phase 0 — Decide (no code)

- Write **ADR-0005: Temporal for run orchestration**, status Proposed.
- Must explicitly answer the "OpenFang owns scheduling" objection.
- **Must decide the run-group data model** (see above). Phases 2–4 are built
  on whatever this decides; deciding it late means rework, not adjustment.
- Must state the failure policy for a partially-failed group.
- License review: Temporal Server and `go.temporal.io/sdk` are both MIT —
  confirm at review against the repo's MIT/Apache-2.0 gate, and record the SDK
  in the provenance ledger like any other new Go dependency.
- Add the record to `docs/adr/README.md`.
- **Gate:** ADR accepted before Phase 2 merges. Phase 1 may proceed in
  parallel as it is reversible infrastructure.

### Phase 1 — Substrate

- `temporal` service in compose, on the existing Postgres.
- `TEMPORAL_*` config in `internal/config` (host, namespace, task queue,
  TLS, `TEMPORAL_ENABLED`). Follow `boolFromEnv` — never `z.coerce.boolean()`
  equivalents.
- Namespace provisioning in the migrator path, or a documented one-shot.
- `/ready` reports Temporal reachability **only when
  `TEMPORAL_REQUIRED=true`**, mirroring the existing `VALKEY_REQUIRED`
  pattern.
- **Gate:** `docker compose up` boots clean with Temporal enabled and
  disabled. No behavior change either way.

### Phase 2 — Run dispatch on Temporal

- `internal/orchestration/` — workflow, activities, worker registration.
- Activities wrap the existing `runadmission.Store` methods verbatim.
- `runadmission.Service` grows a `Dispatcher` interface with two
  implementations: the existing channel pool, and a Temporal client. Selected
  by config.
- **Both paths must pass the existing
  `internal/service/runadmission/service_test.go` and `boundary_test.go`
  suites.** Those tests are the contract; do not weaken them to fit.
- New test: assert `MaximumAttempts == 1` on the dispatch activity options.
  This is the one that stops a future refactor from silently re-POSTing.
- **Gate:** `TEMPORAL_ENABLED=false` is byte-identical to today. With it on,
  kill the worker mid-stream and prove the run lands in
  `reconciliation_required` rather than orphaned.

### Phase 3 — Cancellation via signal

- `POST .../cancel` sends a `CancelRun` signal instead of calling `StopAgent`
  inline.
- The workflow owns the single permitted `StopAgent` call, preserving the
  "one stop call" rule in `RequestCancellation` / `CancelLocally` /
  `ShouldStop`.
- `MarkCancellationUnconfirmed` stays the outcome when the stop is not
  confirmed — Temporal does not get to retry its way to a false `cancelled`.
- **Gate:** cancel during a restart still converges. `ErrCancellationUnconfirmed`
  semantics unchanged.

### Phase 4 — Reconciliation (the actual payoff)

- `ReconcileStaleRuns` workflow on a Temporal Schedule.
- Drains `runs_reconciliation_idx` and stale `runs_dispatch_pending_idx`
  rows — the indexes shipped in migration 003 with no consumer.
- Uses `GET /api/agents/{id}/session` and `GET /api/audit/recent` as the
  reconciliation *evidence* the integration spec describes, then commits a
  terminal ledger state.
- Must never re-POST a dispatch. Reconciliation resolves state; it does not
  re-execute work.
- **Gate:** a run orphaned by `kill -9` reaches a terminal state without
  operator action, and without a second agent execution.

### Phase 5 — Run modes and run groups

- Migration 009: `run_mode` enum, `runs.mode` defaulting to `write`,
  `runs_one_active_writer_per_issue_key` replacing the broad index.
- `run_groups` table; `runs.group_id`.
- `ActiveRunError` → `ActiveWriterError`, raised only on `write` admission.
- `docs/api/gateway-v1.md` gains `mode` and concurrent read runs. `activeRunId`
  keeps its meaning, so nothing is deprecated.
- **Gate:** single-agent runs are byte-identical at the wire. Two concurrent
  `write` admissions on one issue are rejected. Two concurrent `read`
  admissions succeed.

### Phase 6 — Multi-step / multi-agent orchestration

- `RunGroupOrchestration` parent workflow; `RunOrchestration` from Phase 2
  becomes its child, unchanged.
- Bounded fan-out via `workflow.NewSelector` and an explicit concurrency cap.
- Per-group token budget guard.
- Human review gate as a durable signal wait.
- `workflow.GetVersion` discipline from the first commit.
- **Gate:** a multi-step group survives a full worker restart mid-plan, and a
  group paused on human review survives a deploy and resumes on the decision.

### Phase 7 — Follow-ons

- `run_events` retention pruning on a Schedule.
- Revisit whether the inbox projector moves onto Temporal (see open
  questions) — not required, and not free.

## Risks

- **A future contributor adds a retry policy to the dispatch activity.**
  This duplicates paid agent execution and violates the pinned contract.
  *Mitigation:* the assertion test in Phase 2, plus a comment at the
  definition site, plus a line in AGENTS.md.
- **Temporal is read as violating the OpenFang boundary.** *Mitigation:*
  Phase 0 ADR states the product-orchestration vs agent-execution split
  explicitly, before any code lands.
- **Self-hosting burden.** One more service, one more schema, one more
  upgrade path for every operator. This is the largest real cost of the plan
  and it does not go away. *Mitigation:* share the Postgres instance, keep the
  Web UI off, keep `TEMPORAL_ENABLED=false` a fully supported configuration
  through Phase 4.
- **Two dispatch paths diverge.** *Mitigation:* one shared test suite, and
  delete the channel pool once Phase 4 is proven. Do not carry both
  indefinitely.
- **Scope creep into a general workflow engine.** *Mitigation:* Phases 0–4
  only touch the run path. Phase 5 is explicitly optional.

## Why not the Postgres sweeper

A leased Postgres sweeper — `SELECT ... FOR UPDATE SKIP LOCKED` over the two
existing indexes, with a durable checkpoint and a background goroutine —
closes the *correctness* gap in Phases 1–4 with no new service, no new
dependency, and maybe 400 lines.

This codebase has already solved that problem once, this way.
`internal/service/p2/projector.go` drains `outbox_events` with exactly that
pattern: a poll loop wired at `cmd/api/main.go:630`, `FOR UPDATE SKIP LOCKED`
row claiming in `internal/repository/p2/projection.go`, and an
`inbox_projection_events` receipt table as the restart-safe checkpoint.

**It was the right answer until the roadmap answered.** A sweeper restarts
stalled work; it does not orchestrate. Multi-step / multi-agent execution
needs fan-out with bounded concurrency, per-step failure policy, a durable
wait for a human decision that may take days, and per-execution history for
debugging a plan that went wrong at step 4 of 7. Building that on a poll loop
means writing a workflow engine incidentally, badly, and without meaning to.

The sweeper stays the right pattern for the inbox projector. It should not be
extended to own agent orchestration.

## Open questions

**Answered:**

- Multi-step / multi-agent orchestration is on the roadmap (2026-08-23).
  Temporal it is; the sweeper is out.
- Concurrency rule (2026-08-23): multiple agents may be assigned to an issue,
  but only one may edit code at a time. Enforced by run modes plus a narrowed
  partial unique index, and by write steps being awaited in the parent
  workflow.
- Lock scope (2026-08-23): **the issue**. `runs_one_active_writer_per_issue_key`
  is keyed on `issue_id`, matching the design already written above. Agents
  sharing an issue are assumed to share a working tree.

Not modelled, and deliberately out of scope: contention between two *issues*
that touch the same repository. If that becomes real, it needs a lock above
the issue — a Temporal mutex workflow keyed on the repository — and its own
decision record.

Still open, in the order they block work:

1. **Group failure policy** — step 3 of 7 fails: fail the group, continue, or
   pause for a human? Product decision. Blocks Phase 0.
2. **Group-level SSE ordering** — concurrent read runs interleave. Merge
   rule, or per-run substreams the client reassembles? Blocks Phase 5.
3. **Worker placement** — `cmd/worker` recommended, given workers now hold
   day-long human-review waits. Blocks Phase 1.
4. **`TEMPORAL_ENABLED=false`** — permanently supported, or migration-only
   escape hatch? Decides how long the dual dispatch path lives. Blocks
   Phase 2's exit.
5. **Inbox projector** — does it eventually move onto Temporal too? Two
   durability mechanisms in one server is a real maintainability cost. Not
   urgent.
