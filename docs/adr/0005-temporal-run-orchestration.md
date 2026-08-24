# ADR-0005: Adopt Temporal for Berry run orchestration

- **Status:** Proposed
- **Date:** 2026-08-23
- **Deciders:** Berry architecture team
- **Related:** [ADR-0004](0004-go-product-server.md),
  [ADR-0002](0002-valkey-for-ephemeral-state.md),
  [ADR-0003](0003-pin-openfang-by-commit.md),
  [OpenFang integration specification](../integrations/berry-openfang.md),
  [gateway v1 contract](../api/gateway-v1.md),
  [implementation plan](../plans/temporal-run-orchestration.md)

## Context

Berry's run ledger is durable in storage and not durable in execution. Runs
are admitted into PostgreSQL by `internal/handlers/runs/admission.go`, then
handed to a process-local Go channel in
`internal/service/runadmission/service.go`. If the API process stops between
those two facts, nothing resumes the run.

The consequences are already visible in the schema. Migration
`003_agents_and_run_admission.up.sql` creates `runs_dispatch_pending_idx` and
`runs_reconciliation_idx`, and `internal/repository/runs/models.go` defines a
`reconciliation_required` dispatch state. No component consumes any of them.
The run state machine is complete; its driver is not.

Two forces decide what replaces the channel.

**First, OpenFang's contract limits what any solution can promise.** There is
no SSE resume cursor, and re-POSTing `/api/agents/{id}/message/stream`
duplicates paid agent execution
([integration spec](../integrations/berry-openfang.md)).
`internal/openfang/transport.go` encodes this as "Unsafe POST dispatch is
attempted exactly once." A crashed stream is a lost stream under any design.
What is achievable is that the loss becomes *detected and terminal* rather
than a row stuck forever.

**Second, the roadmap now includes multi-step and multi-agent orchestration.**
Confirmed 2026-08-23. This changes the decision. A leased PostgreSQL sweeper
would close the durability gap — and the pattern already ships in this
repository, in `internal/service/p2/projector.go`, draining `outbox_events`
with `FOR UPDATE SKIP LOCKED` and a receipt table. But a sweeper restarts
stalled work; it does not orchestrate. Fan-out with bounded concurrency,
per-step failure policy, a durable wait for a human decision that may take
days, and per-execution history for debugging a plan that failed at step 4 of
7 are not sweeper concerns. Building them on a poll loop means writing a
workflow engine incidentally and without meaning to.

Berry's core loop ends in a human review gate, and the release gate is always
human. Durable multi-day waits are therefore a first-class product
requirement, not an edge case.

Orchestration is also bounded by a product invariant stated 2026-08-23:
multiple agents may be assigned to one issue, but only one may edit code at a
time, because concurrent editors produce race conditions and inconsistent
code. Any orchestration design must serialise code-editing work while still
allowing read-only work — review, analysis, planning — to run concurrently.

## Decision drivers

- Admitted runs must survive process restart, deploy, and node loss.
- `reconciliation_required` must have a consumer.
- At-most-once upstream dispatch must be preserved exactly as it is today.
- Multi-step and multi-agent execution must be expressible without building a
  bespoke orchestrator.
- A human review gate must be able to block execution for days, durably.
- Self-hosted deployments stay complete and operable (ADR-0004).
- PostgreSQL stays the system of record (ADR-0002, ADR-0004).

## Considered options

1. Adopt Temporal as the durable executor for Berry's run orchestration.
2. Build a leased PostgreSQL sweeper over the existing dispatch indexes,
   reusing the inbox projector pattern.
3. Leave dispatch in the in-process worker pool and accept orphaned runs.

## Decision

Berry adopts **Temporal** as the durable executor for run orchestration, in
`server/` only.

**Ownership.** Temporal executes; it does not remember. PostgreSQL remains
authoritative for the run ledger, `run_events`, and every API read. Temporal
history is operational evidence and is never read to answer an API request.
Deleting a Temporal namespace must not lose product state.

**The OpenFang boundary is unchanged.** ADR-0004 reserves agent execution,
sandboxing, scheduling, model and provider access to OpenFang. Temporal
schedules *Berry's product-side orchestration* — when to dispatch, when to
reconcile, when to wait for a human. It never executes agent work, and Berry
gains no execution capability from it. Every upstream call still goes through
`internal/openfang`.

**At-most-once dispatch is a hard invariant.** The activity wrapping
`POST /api/agents/{id}/message/stream` is configured with
`RetryPolicy{MaximumAttempts: 1}` and is covered by a test asserting that
value. Heartbeat timeout on that activity resolves to
`reconciliation_required` and never to a retry. Only operations classified
`RetryRead` or `RetryIdempotentWrite` by `internal/openfang/transport.go` may
carry a retrying policy.

**The public contract is unchanged by adoption.** `/api/v1`, the error
envelope, cursor pagination, `Idempotency-Key`, and SSE framing are
untouched by Temporal itself. The separate run-group change below does extend
the contract, deliberately.

**One code-editing agent per issue.** Multiple agents may be assigned to an
issue, but at most one may edit code at a time; concurrent editors produce
race conditions and inconsistent code. Berry adds a `mode` to `runs`
distinguishing `write` runs, which may modify a working tree, from `read`
runs, which may not. `runs_one_active_per_issue_key` is **narrowed** rather
than removed:

```sql
CREATE UNIQUE INDEX runs_one_active_writer_per_issue_key
    ON runs (issue_id)
    WHERE status IN ('queued', 'running') AND mode = 'write';
```

`mode` defaults to `write`, so every existing row keeps today's behavior and
the migration is behavior-preserving. `ActiveRunError` becomes
`ActiveWriterError` and is raised only on `write` admission. The denormalized
`issues.active_run_id` and the public `activeRunId` field keep their meaning —
the active writer — so **this is not a breaking contract change**;
`docs/api/gateway-v1.md` gains `mode` and concurrent read runs without
deprecating anything.

The write lock is scoped to the **issue**:
`runs_one_active_writer_per_issue_key` is keyed on `issue_id`, on the
assumption that agents sharing an issue share a working tree. Contention
between two issues that touch the same repository is not modelled by this
ADR; if it becomes real it needs a lock above the issue and its own record.

The invariant is protected twice. `RunGroupOrchestration` awaits every `write`
child before starting the next, so writes are serialised by deterministic
workflow logic that a reviewer can see; the partial unique index rejects a
violation regardless. The failure mode is silent code corruption across two
agents, which justifies defence in depth.

**Run groups.** Multi-step execution also requires a parent resource above
`runs`, holding plan-level state that belongs to no single run: group status,
current step, the token budget for the whole plan, and group-scoped
cancellation. Berry adds a `run_groups` table and `runs.group_id`. A
single-agent run is a group of one, so there is one code path rather than two.
The group does **not** own the write lock; the issue does. That separation is
what keeps the migration small.

**Naming.** OpenFang exposes its own `workflows` API, and AGENTS.md forbids
OpenFang-derived identifiers in new code. Berry's Temporal package is
`internal/orchestration`, with `RunOrchestration` and
`RunGroupOrchestration`. No Berry symbol is named `workflow`.

**Deployment.** Temporal runs as a compose service against the existing
PostgreSQL container using separate `temporal` and `temporal_visibility`
databases. The Temporal Web UI is disabled by default and opt-in by
configuration. Workers run as a separate `cmd/worker` binary.
`TEMPORAL_ENABLED=false` selects the existing in-process dispatcher and is a
supported configuration until the dual path is removed.

**Licensing.** Temporal Server and `go.temporal.io/sdk` are MIT. Both are
recorded in the provenance ledger before merge, as with any new Go
dependency.

## Consequences

### Positive

- Admitted runs survive restart. This is unavailable today at any price short
  of building the alternative.
- `reconciliation_required` gains a consumer, and the two orphaned indexes in
  migration 003 gain a purpose.
- Cancellation becomes a signal to the workflow that owns the stream, so it
  survives a restart instead of racing an in-process goroutine.
- A human review gate can block for days with no polling, no timer table, and
  no state-machine column encoding "waiting".
- Multi-step and multi-agent plans are expressible as parent and child
  workflows rather than as bespoke coordination code.
- Every stuck run becomes a queryable execution with full history.

### Negative

- One more service, one more schema, and one more upgrade path for every
  self-hosted operator. This is the largest real cost and it does not go away.
- Two durability mechanisms in one server: Temporal for runs, the leased
  projector for the outbox. Reconciling or keeping both is an open question.
- Workflow determinism constrains how orchestration code may be written and
  requires `workflow.GetVersion` discipline for every change made while
  executions are in flight.
- Multi-agent fan-out multiplies token spend with no natural backpressure.
- The run-mode migration alters the guard that prevents duplicate dispatch,
  though narrowing it with a `write` default is materially safer than
  replacing it.
- Read and write runs are a new distinction every future agent capability has
  to be classified against, and misclassifying a code-editing agent as `read`
  defeats the invariant.

### Risks and mitigations

- **Risk:** A contributor adds a retry policy to the dispatch activity,
  duplicating paid agent execution and violating the pinned contract.
  **Mitigation:** An assertion test on `MaximumAttempts`, a comment at the
  definition site, and a line in AGENTS.md.
- **Risk:** Temporal is read as violating OpenFang's ownership of scheduling.
  **Mitigation:** The product-orchestration versus agent-execution split is
  stated in this ADR before any code lands.
- **Risk:** Narrowing the active-run index weakens redispatch protection or
  admits two concurrent editors. **Mitigation:** `mode` defaults to `write`,
  so the migration is behavior-preserving; swap the index and the admission
  guard atomically; prove before merge that two concurrent `write` admissions
  on one issue are still rejected.
- **Risk:** A future orchestration step fans out two `write` children,
  corrupting a working tree. **Mitigation:** Write children are awaited in
  workflow code, and the partial unique index rejects the admission even if
  that logic regresses.
- **Risk:** Adoption is read as a promise that crashed streams resume. It is
  not; OpenFang has no resume cursor. **Mitigation:** Stated here and in the
  plan; the achievable outcome is detection and a terminal state.
- **Risk:** Self-hosting burden drives operators away. **Mitigation:** Share
  the PostgreSQL instance, keep the Web UI off by default, and keep
  `TEMPORAL_ENABLED=false` fully supported through the reconciliation phase.
- **Risk:** Scope creep into a general workflow engine. **Mitigation:** Only
  the run path is in scope. The inbox projector stays on its existing pattern
  unless a later ADR moves it.

## Validation

- With `TEMPORAL_ENABLED=false`, behavior is identical to the in-process
  dispatcher and the existing `runadmission` test suites pass unchanged.
- A test asserts `MaximumAttempts == 1` on the dispatch activity.
- Killing a worker mid-stream lands the run in `reconciliation_required`
  rather than orphaned, and produces no second upstream dispatch.
- A run orphaned by `kill -9` reaches a terminal state without operator
  action.
- Cancellation issued during a restart converges, and
  `ErrCancellationUnconfirmed` semantics are unchanged.
- After the run-mode change, single-agent runs are byte-identical at the wire.
  Two concurrent `write` admissions on one issue are rejected; two concurrent
  `read` admissions succeed.
- A multi-step group survives a full worker restart mid-plan; a group paused
  on human review survives a deploy and resumes on the decision.
- `docker compose up` boots clean with Temporal enabled and disabled.

## Follow-up

- Decide the partially-failed-group failure policy before implementation
  begins; it blocks the first phase.
- Decide the group-level SSE ordering rule before the contract change.
- Record `go.temporal.io/sdk` in the provenance ledger.
- Add the at-most-once dispatch rule to AGENTS.md.
- Revisit whether the inbox projector moves onto Temporal, as a later ADR.
