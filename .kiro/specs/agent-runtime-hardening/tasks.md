# Implementation Plan: Agent Runtime Hardening

## Overview

This plan turns the findings of the agent-implementation review into incremental coding tasks for
`@berry/server`. It is scoped to the run path — `src/agents/`, `src/runs/`, `src/execution/`,
`src/runtime/`, `src/realtime/replay.ts` — and touches no frontend code.

It is ordered by consequence, not by file. Phase 1 stops the run path from losing or misreporting
work that was already paid for. Phase 2 makes the ledger affordable and the run stream complete.
Phase 3 closes the permission boundary. Phase 4 makes the three execution drivers honour the seam
they claim to implement. Phase 5 fixes classification and error propagation. Phase 6 removes the
ADK-era residue and covers the orchestration loop that currently has no test. Phase 7 is design work
that needs a decision before it becomes code.

**Baseline at the time of writing.** `pnpm typecheck:server` exits 0. `pnpm test:server` reports 499
pass / 1 skipped / 0 fail across 31 suites. Branch `refactor/architecture-clarity`, working tree
clean, last commit `e3cbcc4` (BERR-65). Highest issue reference in history is BERR-65, so this plan
allocates **BERR-66 onward**. Highest applied migration is `051`, so the first new one is **`052`**.

**Stack constraints reflected in every task.** The server runs `.ts` directly under
`node --experimental-strip-types` with **no build step** and `erasableSyntaxOnly` — no `enum`, no
`namespace`, no parameter properties. TypeScript `strict` with `noUncheckedIndexedAccess` and
`exactOptionalPropertyTypes`; no `any`; narrow rather than `!`. Zod **v4** at server boundaries (the
frontend's v3 is a different workspace and must not be conflated). Migrations are forward-only,
checksummed and immutable — never edit `001`–`051`; add `052` onward. Tests run under `node --test`,
co-located as `*.test.ts`, named after the guarantee; DB-backed tests self-skip when
`BERRY_TEST_DATABASE_URL` is unset and **must stay that way**. The `/api/v1` wire contract, error
envelope, cursor pagination, `Idempotency-Key` semantics and already-issued cursors keep decoding.

**Process constraints.** One issue per branch and PR (`fix/berr-NN-short-slug` for hand-authored
work). Commits are `type(scope): imperative summary (BERR-NN)`. Reviewer for every task here is
**Backend PR Adversary**; zero blocking findings is merge authority, and a re-review reads the full
PR rather than the delta.

**Verification commands** (used by every checkpoint):

- Server types: `pnpm typecheck:server`
- Server tests: `pnpm test:server` — and again with `BERRY_TEST_DATABASE_URL` exported and
  `pnpm migrate:server` applied, for the DB-backed tasks
- Compose/deployment pins, when a task touches them: `python3 scripts/check-compose-config.py`

## Findings register

> **2026-09-09 — closed by the Strands-native runtime refactor (ADR-0013):** F-02, F-09, F-10,
> F-22, F-23, F-25, F-26, F-31, F-32, F-37 and F-38 are addressed on branch
> `refactor/strands-native-runtime`; see `docs/superpowers/specs/2026-09-09-strands-native-agent-runtime-design.md`
> §7 for the mapping. Tasks 2.1, 2.3, 2.4, 9.1, 9.2 (D3 decided: ungated, stated in
> `runtime/plugins/permissions.ts`), 16.1, 16.3 and 17.1 are done there; the rest of this plan is
> unaffected. Note also that BERR-66 and BERR-67 were spent by other commits before this plan began,
> so allocation starts at BERR-68.

Traceability for this plan. There is no `requirements.md`; tasks reference these ids instead.
"Confirmed" records how the finding was established, because three of them rest on behaviour that
was not reproduced against a live service and must be checked before the fix is trusted.

| Id | Finding | Confirmed |
| --- | --- | --- |
| F-01 | `deliveryContract()` tells the agent to save committable files with `write_file`, which writes `run_artifacts` rows and bucket objects; `commitAndPush` runs `git add -A` on the checkout. Nothing bridges them, and `session.writeFile` has no caller in `src/agents/`. A compliant agent commits nothing and the run still reports success. | Read + grep |
| F-02 | `succeed()` calls `ledger.completeSuccess` unguarded (`executor.ts:491`) while `fail()`/`cancel()` both swallow `RunTerminal`. A run swept mid-completion has its success thrown away and recorded `DISPATCH_ABANDONED`; `postRunResult` never fires. | Read + grep |
| F-03 | `deliverRepository` pushes at `repository-run.ts:178` and checks `require('open_pull_requests')` at `:191`. A denied agent leaves a pushed branch with no `run.delivered`, no `runs.branch`, no `head_commit`, and a failed run. | Read |
| F-04 | The adjacent `UPDATE runs SET branch, head_commit, pull_request_number` ends `.catch(() => undefined)`, so `appendDelivered` can claim a branch the `runs` row does not have. | Read |
| F-05 | `eventTimes` runs `MAX(occurred_at) WHERE run_id = $1` on every append. `run_events` has no `(run_id, occurred_at)` index, making append cost quadratic in events per run. | Read + grep |
| F-06 | No retention job exists for `run_events` or `outbox_events`. `run_events_retention_idx` (migration 003) was created for a sweep that was never written; `mounts/events.ts` enforces a 24h *read* cutoff only. | Grep |
| F-07 | Nothing caps events per run. `runs.output` is bounded to 1 MiB in SQL, but `run.command.output` deliberately bypasses that column, so a verbose build writes unbounded rows. | Read |
| F-08 | `BOARD_TOPICS` omits `run.command.started`, `run.command.output`, `run.command.completed`, `run.repository.ready`, `run.verified`, `run.delivered`. All six are written to `outbox_events` and silently never delivered to any SSE client. | Read + grep |
| F-09 | Five of six tools have no permission check. `write_file` mutates durable state unchecked, and no member of `PERMISSIONS` covers artifacts. | Read |
| F-10 | The one in-tool check is fail-open: `permissions?: PermissionSet` with `?.require(...)` (`command-tool.ts:65`, `:111`), inverting `permissions.ts`'s stated "absence is denial". `noPermissions()` exists for this and is unused. | Read |
| F-11 | `verify()` runs project-configured `verify_commands` in the container with no `run_commands` check, giving any project editor command execution in every run on that project. | Read |
| F-12 | `command-tool.ts` passes no `timeoutMs`, while `verification.ts` does. Under `agentcore.ts` that is genuinely unbounded. | Read |
| F-13 | Agent-supplied `cwd` overrides the checkout directory and is unvalidated; `ExecOptions.cwd` permits absolute paths. | Read |
| F-14 | `agentcore.ts` collapses exit codes to `failed ? 1 : 0` and classifies stdout/stderr from the same `isError` flag, contradicting `driver.ts`'s "0 is success … signalled reports 128+n". | Read; **live check needed** on whether `InvokeCodeInterpreter` sets `isError` for a non-zero shell exit |
| F-15 | `agentcore.ts` declares `DEFAULT_TIMEOUT_MS` and never reads it or `options.timeoutMs`; `stop()` is a no-op. Combined: no ceiling, no cancel, no kill. | Read |
| F-16 | The shell prelude has no `set -e`, so a failed `cd` runs the command anyway in the wrong directory. With F-14 that can read as success. | Read |
| F-17 | Both AgentCore drivers yield `error` then `exit 1`; `command-tool.ts` returns `error` only when `exitCode === null`, so `ThrottlingException`, `AccessDeniedException` and `TIMED_OUT` reach the model as "exit 1, no output" and reach `run_events` as nothing. The docker driver emits `error` with no trailing `exit`, so the same union carries two incompatible protocols. | Read |
| F-18 | `http.ts` buffered `exec` never passes `abort`, falling to `AbortSignal.timeout(30_000)`. Every `git clone`/`git push` is aborted at 30s as `ExecutionUnavailable` while the container keeps working; the body's `timeoutMs` is unreachable. | Read |
| F-19 | `health()` has zero callers repo-wide; `/ready` probes only Postgres. `session.stop()` also has zero callers, making the sidecar's `POST /sessions/:id/stop` dead. | Grep |
| F-20 | `agentcore.ts`'s comment claims the run id makes a retry reach the same workspace. `StartCodeInterpreterSession` returns a fresh `sessionId` per call and `name` is not an idempotency key. Its two siblings do have the property. | Read |
| F-21 | `config.ts` defaults `codeInterpreterId` to `aws.codeinterpreter.v1`, which `runtime/README.md` documents as unusable for repository work. Verified live in this workspace: node and curl present, **git absent**. | Read + live |
| F-22 | `failureCode`/`isRetryable` read `(error as {status?: number}).status`. AWS SDK v3 errors carry `$metadata.httpStatusCode`, so Bedrock 429/5xx classify as non-retryable `RUNTIME_ERROR` — the case these functions exist for. | Read; **verify** the exact field on a real `ThrottlingException` |
| F-23 | A thrown tool becomes `toolResultEvent{status:'error'}` → `tool_completed(ok:false)` and the run continues and can still succeed. Nothing gates on `ok`. | Read |
| F-24 | `buildMessage` reserves room for the contracts and truncates the tail, but the tail is `reviewFeedback` → `priorWork` → `Repository:`. A long description evicts the review feedback the code itself calls "the sharper instruction". | Read |
| F-25 | `index.ts:219` spreads `credentials` into `AdkExecutor`; `ExecutorOptions` declares no such field, so spread escapes excess-property checking and the value is discarded. The model picker uses explicit credentials, runs fall back to the default chain. `maxTokens`/`temperature` are likewise never populated. | Read + grep |
| F-26 | Dead code and stale vocabulary: `let streamed` (`executor.ts:315`, declared, never read), `stillOpen()` (exported, no caller), `artifactKey()`'s dummy ADK triple, the `AdkExecutor` name and ADK comments over a Strands implementation, and `AGENTS.md`/ADR-0008 both naming Google ADK. | Read + grep |
| F-27 | `dispatch_state = 'cancel_requested'` is read at `ledger.ts:204`, `:212`, `:429` and **written nowhere**. `RunCancelling` and `markRunning`'s cancel-survives-dispatch branch are unreachable; `cancel_requested_at`/`cancel_requested_by` are never written. | Grep |
| F-28 | `mounts/runs.ts` documents cancel as returning a run that "may still be `running`". `markCancelled` always commits terminal, so the 202 body always says `cancelled` while the model call bills for up to one heartbeat (15s). | Read |
| F-29 | `beat()` swallows every error, so cancel delivery rides a best-effort channel: a run whose beats keep failing never learns it was cancelled and runs to completion unaborted. | Read |
| F-30 | `failure_retryable = true` has no retry mechanism and no attempt counter on `runs`. `DISPATCH_ABANDONED` looks retryable; nothing retries it. | Grep |
| F-31 | `executor.test.ts` covers only pure helpers. The orchestration loop, cancellation path, delivery ordering and permission enforcement have no test. | Read |
| F-32 | Untrusted content reaches the model unlabelled and undelimited: issue fields, `issue_auto_reviews.reason` (another model's output, wrapped in "Address that specifically"), Memory recall, and tool returns. Empty system prompt is permitted. | Read |
| F-33 | No per-workspace, per-agent, global or cost cap. `PlanTriage.triage` admits one run per plan task with no ceiling and swallows per-task failures. | Read + grep |
| F-34 | No DB-level transition guard on `runs.status` or `status`↔`dispatch_state`; `runs_dispatch_state_ck` is `NOT VALID`. Every transition invariant is application-side. | Read |
| F-35 | `runToken` ends `return deps.connections!.token(...)`. With `githubApp` configured but holding no App row and `connections` undefined, this is a `TypeError`; the guard at `repository-run.ts:84` passes on `githubApp` alone. A `!` in a repo whose rules say narrow instead. | Read |
| F-36 | `provider-factory.ts` falls through to a fully-null SCM when the gateway is configured but `startGateway` returns no provider, disabling repository work even though a working GitHub App exists. | Read |
| F-37 | `lazyWorkspace` memoises the `createSession` **promise**, so one transient failure poisons every later `run_command` in the run with the same stale error. | Read |
| F-38 | `markRunning` is not inside a try (`executor.ts:275`). A cancel landing between `claimDispatch` and `markRunning` throws out of `execute()`, breaking the `Promise<RunOutcome>` contract; the dispatcher only logs. | Read |
| F-39 | Under the AgentCore drivers the per-command prelude composes `export BERRY_GIT_TOKEN='ghs_…'` into the command string sent to AWS (base64-wrapped for the runtime driver). `checkout.ts`'s invariant holds inside Berry but not at the AWS boundary. Prelude text can also reach a stderr-derived failure message. | Read |
| F-40 | `CreateSessionInput.env` is documented as where secrets belong, but session env is re-exported into every command for the session's life (AgentCore) or becomes container `Env` readable via `printenv` (docker). Latent — `executor.ts` passes no `env` — but the interface recommends the unsafe path. | Read |

## Phase 0 — Decisions needed before Phase 1 starts

These are not coding tasks. Each changes what the tasks below should say, and guessing wrong means
rework. Written out so they can be answered in one sitting.

- [ ] 0. Resolve the four open decisions
  - [ ] 0.1 **D1 — How does an agent hand back code?** (blocks 1.1, F-01)
    - Option A: materialize `run_artifacts` into the checkout before `git add -A`. Keeps the
      contract the prompt already states and keeps artifacts as the cross-agent handoff.
    - Option B: rewrite `deliveryContract()` to tell the agent to write into the working tree with
      `run_command`, and reserve `write_file` for non-committable output.
    - The plan below assumes **A**, with B noted per task. Either way a repository run that commits
      nothing must stop reporting success.
  - [ ] 0.2 **D2 — Does the Code Interpreter driver stay?** (blocks 4.2, F-14/F-15/F-20/F-21)
    - ADR-0012 records `agentcore-runtime` as the live substrate and `runtime/README.md` documents
      the managed interpreter as unusable for repository work — confirmed live: no `git`.
    - Option A: make `agentcore.ts` conform to `driver.ts` (real exit codes, honour `timeoutMs`,
      `set -e`) and keep it for non-repository runs.
    - Option B: remove the driver and its `BERRY_RUNTIME_DRIVER=agentcore` selection, leaving
      `docker` and `agentcore-runtime`.
    - The plan assumes **A** but marks the tasks B would delete. Independent of the choice, the
      `aws.codeinterpreter.v1` default in `config.ts` should stop pointing at a substrate that
      cannot clone.
  - [ ] 0.3 **D3 — Do artifact writes need a permission?** (blocks 3.1, F-09)
    - Adding one to `PERMISSIONS` means existing agent rows lack it, so it needs a migration in the
      shape of `034` to grant it to current agents — otherwise every existing agent loses
      `write_file` on deploy.
    - The alternative is to state in `permissions.ts` that artifact writes are deliberately
      ungated, so the omission reads as a decision rather than an oversight.
  - [ ] 0.4 **D4 — What is the retention policy for `run_events` and `outbox_events`?** (blocks 2.2,
    F-06)
    - This deletes durable product rows, so it needs explicit sign-off on the window and on whether
      terminal-run events are kept longer than in-flight chatter. `mounts/events.ts` already reads
      only the last 24h, which is a floor, not an answer.

## Phase 1 — Stop losing work (BERR-66 … BERR-68)

- [ ] 1. BERR-66: artifacts reach the commit, and an empty delivery stops reporting success
  - [ ] 1.1 Bridge artifacts into the checkout before staging
    - Assuming **D1 option A**: in `src/agents/delivery.ts`, before `git add -A`, materialize this
      run's artifacts into `prepared.checkout.directory` using `session.writeFile` — the method every
      driver implements and nothing currently calls
    - Enumerate with `BerryArtifactService.listArtifactKeys` and read with `loadArtifact`; reject any
      artifact path that escapes the checkout root (`..`, absolute) rather than writing it
    - Artifact paths are already repository-relative by the contract's own wording, so the mapping is
      `directory + '/' + path`
    - _Findings: F-01_
  - [ ] 1.2 Make a no-op delivery visible instead of silently successful
    - `commitAndPush` returning `committed: false` on a run whose project names a repository is
      currently a success with no PR. Decide it once and record it: either fail the run with a
      distinct code, or succeed while making `run.delivered` state plainly that nothing was committed
    - Whichever is chosen, the summary posted on the issue must not read as delivered work
    - _Findings: F-01_
  - [ ] 1.3 Correct `deliveryContract()` and `reportingContract()`
    - `deliveryContract()` claims "there is no git, no credential and no network path to the
      repository". `checkout.ts` clones with real git into the same session, so the sentence is false
      and predates the checkout
    - Rewrite both contracts to describe the mechanism that exists after 1.1. If **D1 option B** was
      chosen, this task is the whole fix and 1.1 is dropped
    - _Findings: F-01_
  - [ ] 1.4 Test the delivery path end to end
    - `delivery.test.ts`: an artifact saved at `src/api/handler.go` appears in the staged diff; an
      artifact path containing `..` is refused and does not write outside the checkout; a run with no
      artifacts and no worktree change does not report delivered work
    - Name each after the guarantee, per the playbook
    - _Findings: F-01_

- [ ] 2. BERR-67: a completed run is never recorded as abandoned
  - [ ] 2.1 Guard `succeed()` the way `fail()` and `cancel()` are guarded
    - In `src/agents/executor.ts`, wrap `ledger.completeSuccess` so `RunTerminal` does not propagate
      out of `execute()`
    - Decide what a swept-but-completed run records. Reporting success over a terminal row is not
      available — `completeSuccess` refuses it — so the outcome is either a reconciliation state or a
      returned `RunOutcome` that admits the ledger disagrees. Do not silently discard the summary and
      usage: they are what the run was paid for
    - _Findings: F-02_
  - [ ] 2.2 Stop `beat()` from silently dropping cancellation
    - `dispatcher.ts` swallows every beat error on the reasoning that the lease outlives several
      beats. That is true of the lease and false of the abort that rides the same statement. Count
      consecutive failures and abort locally once the lease can no longer be assumed held
    - _Findings: F-29_
  - [ ] 2.3 Put `markRunning` inside the try
    - A cancel landing between `claimDispatch` and `markRunning` currently throws out of `execute()`
      and breaks the `Promise<RunOutcome>` contract
    - _Findings: F-38_
  - [ ] 2.4 Stop `lazyWorkspace` memoising rejections
    - Cache the session, not the promise, on the failure path, so one transient `createSession`
      failure does not poison every later `run_command` in the run
    - _Findings: F-37_
  - [ ] 2.5 Tests for the sweep race and the cancel-during-dispatch race
    - DB-backed, self-skipping: a run swept while completing does not lose its summary; a cancel
      between claim and `markRunning` returns a `RunOutcome` rather than throwing; a failing
      `createSession` followed by a working one does not return the stale error
    - _Findings: F-02, F-37, F-38_

- [ ] 3. BERR-68: permission precedes the side effect it gates
  - [ ] 3.1 Move `require('open_pull_requests')` ahead of the push
    - In `src/agents/repository-run.ts`, check before `commitAndPush` rather than between the push
      and the PR. Checking a permission after the effect it guards is wrong regardless of the orphan
      branch it leaves
    - Keep the existing `read_repository` / `create_branches` checks where they are — those already
      run before the credential is decrypted, which is the right shape
    - _Findings: F-03_
  - [ ] 3.2 Stop swallowing the `runs` delivery UPDATE
    - The `.catch(() => undefined)` lets `appendDelivered` claim a branch the row does not have. Let
      it fail, or reconcile it, but do not let the two records diverge silently
    - _Findings: F-04_
  - [ ] 3.3 Narrow `runToken`'s non-null assertion
    - `deps.connections!.token(...)` is a `TypeError` when `githubApp` exists with no App row and
      `connections` is undefined; the guard at `:84` passes on `githubApp` alone. Narrow and raise a
      typed failure instead
    - _Findings: F-35_
  - [ ] 3.4 Tests for delivery ordering
    - An agent without `open_pull_requests` pushes nothing; the delivered event and `runs.branch`
      never disagree; a deployment with an App row absent and no connections fails with a typed
      error rather than a `TypeError`
    - _Findings: F-03, F-04, F-35_

- [ ] 4. Checkpoint — work-loss paths closed
  - Run `pnpm typecheck:server` and `pnpm test:server`, then again with `BERRY_TEST_DATABASE_URL`
    exported. Ask before proceeding if D1 was answered differently from the assumption in 1.1.

## Phase 2 — The ledger and the run stream (BERR-69 … BERR-71)

- [ ] 5. BERR-69: migration 052 — make appends cheap
  - [ ] 5.1 Add `server-ts/migrations/052_run_events_occurred_at_index.up.sql`
    - `CREATE INDEX IF NOT EXISTS run_events_run_occurred_idx ON run_events (run_id, occurred_at)`,
      which is what `eventTimes`'s per-append `MAX(occurred_at)` needs and no existing index provides
    - Write the matching `.down.sql`. Do not touch `001`–`051`
    - Consider `CONCURRENTLY` and what that means for the advisory-locked runner in `src/migrate` —
      it cannot run inside the migration transaction, so this needs deciding rather than assuming
    - _Findings: F-05_
  - [ ] 5.2 Pin the cost with a test
    - DB-backed and self-skipping: appending N events to one run does not degrade superlinearly.
      Assert on plan shape or on a bounded ratio rather than wall-clock, so it is not flaky in CI
    - _Findings: F-05_

- [ ] 6. BERR-70: bound `run_events` growth
  - [ ] 6.1 Cap command output per run
    - `command-tool.ts` bounds bytes per command; nothing bounds commands per run, and
      `run.command.output` deliberately bypasses the 1 MiB `runs.output` ceiling. Add a per-run
      aggregate ceiling and record that it was reached, the way `recorder.truncated` already does
    - While in that file, fix `MAX_RECORDED_BYTES` and `MAX_MODEL_BYTES`, which are named `BYTES` and
      measured with `.length` — UTF-16 code units. Non-ASCII output records and forwards materially
      more than the constants claim
    - _Findings: F-07_
  - [ ] 6.2 Write the retention sweep the index was built for
    - Requires **D4**. `run_events_retention_idx` exists from migration 003 for a sweep nobody wrote;
      `outbox_events` is pruned only by `src/reset/reset.ts`, which is a full wipe
    - This deletes durable product rows. Gate it behind explicit configuration, make the window
      configurable, and log what it removed
    - _Findings: F-06_
  - [ ] 6.3 Add `hasNextPage` to the run event page
    - `GET /api/v1/runs/{id}/events` returns `cursor` and nothing else, so a client receiving exactly
      `EVENT_PAGE` events cannot tell "caught up" from "500 more waiting". Every other listing in the
      file uses `connection()` with `pageInfo.hasNextPage` by fetching `first + 1`
    - This is an additive field. Existing cursors must keep decoding
    - _Findings: F-06_

- [ ] 7. BERR-71: deliver the six missing run topics
  - [ ] 7.1 Add the missing topics to `BOARD_TOPICS`
    - `src/realtime/replay.ts` omits `run.command.started`, `run.command.output`,
      `run.command.completed`, `run.repository.ready`, `run.verified`, `run.delivered`. The ledger
      writes all six to `outbox_events`; the replay filters `topic = ANY($topics)`, so they are
      persisted and never delivered
    - The comment on `WORKSPACE_TOPICS` already warns that a missing topic is "a fact that silently
      never arrives". Consider deriving both lists from the ledger's own event names so the next
      addition cannot drift
    - _Findings: F-08_
  - [ ] 7.2 Test that every ledger topic is replayable
    - Enumerate the event types the ledger can write and assert each appears in exactly one of
      `BOARD_TOPICS` / `WORKSPACE_TOPICS`. This is the test that would have caught F-08
    - _Findings: F-08_

- [ ] 8. Checkpoint — ledger and stream
  - `pnpm typecheck:server`, `pnpm test:server` with the DB gate exported and `052` applied via
    `pnpm migrate:server`. Confirm a live run's commands now appear in the board stream.

## Phase 3 — The permission and command boundary (BERR-72, BERR-73)

- [ ] 9. BERR-72: permissions fail closed
  - [ ] 9.1 Make `permissions` required in `CommandToolScope`
    - `command-tool.ts` declares `permissions?: PermissionSet` and calls `?.require(...)`, so an
      omitting caller gets unrestricted `run_command`. `executor.ts` always passes it today, so this
      is latent — but it inverts the module's own "absence is denial", and `noPermissions()` exists
      for exactly this and is unused
    - _Findings: F-10_
  - [ ] 9.2 Settle artifact-write authorization
    - Requires **D3**. Either add the permission plus a `034`-shaped migration granting it to
      existing agents, or record in `permissions.ts` that artifact writes are deliberately ungated
    - Do not leave `write_file` as the only durable-state mutation with no check and no explanation
    - _Findings: F-09_
  - [ ] 9.3 Decide who authorizes `verify_commands`
    - `verify()` runs project-configured shell in the container with no `run_commands` check, so any
      project editor has command execution in every run on that project. The `verification.ts`
      comment frames this only as a safety property
    - Either gate it, or state the privilege alongside the safety claim so it is a documented
      decision
    - _Findings: F-11_
  - [ ] 9.4 Tests for the enforcement points
    - A scope built without permissions refuses `run_command`; each permission's denial is a result
      the model can read rather than a thrown error; the granted set in a run's record matches what
      was enforced
    - _Findings: F-09, F-10, F-11_

- [ ] 10. BERR-73: bound and validate agent commands
  - [ ] 10.1 Pass a timeout from the command tool
    - `command-tool.ts` sends no `timeoutMs` while `verification.ts` computes one. `driver.ts` says
      absent means the driver's default and "never unlimited", and `agentcore.ts` does not honour
      that. Berry currently bounds its own commands and not the agent's
    - _Findings: F-12, F-15_
  - [ ] 10.2 Validate agent-supplied `cwd`
    - The agent's `cwd` currently wins over the checkout directory and is unvalidated; the schema
      describes it as workspace-relative and nothing enforces that. Resolve it against the checkout
      root and refuse escapes
    - _Findings: F-13_
  - [ ] 10.3 Tests
    - A command with no timeout still receives a ceiling; `cwd: '/'` and `cwd: '../..'` are refused;
      a relative `cwd` resolves inside the checkout
    - _Findings: F-12, F-13_

## Phase 4 — Substrate contract conformance (BERR-74 … BERR-77)

- [ ] 11. BERR-74: buffered `exec` is no longer capped at 30s
  - [ ] 11.1 Pass the caller's signal through `exec` on the docker driver
    - `http.ts`'s `exec` omits `abort`, so it falls to `AbortSignal.timeout(30_000)`. Every
      `git clone` and `git push` — all of `checkout.ts` and `delivery.ts` — is aborted client-side at
      30s as `ExecutionUnavailable` while the container keeps going, and the body's `timeoutMs` can
      never be reached
    - Mirror the reasoning already written for `stream`: the request needs a ceiling, and the
      caller's cancellation still applies
    - _Findings: F-18_
  - [ ] 11.2 Test that a slow buffered exec is bounded by its own timeout, not by 30s
    - _Findings: F-18_

- [ ] 12. BERR-75: the Code Interpreter driver honours the seam
  - Requires **D2**. Under option B this whole task is replaced by removing the driver and its
    config selection, and 12.1–12.4 are dropped.
  - [ ] 12.1 Establish what the service actually reports
    - Reproduce against live AgentCore whether `InvokeCodeInterpreter` sets `isError` for a non-zero
      shell exit, and whether a real exit code is recoverable. The current
      `exitCode: failed ? 1 : 0` and the stdout/stderr classification both hang off that one flag,
      and `checkout.ts`/`delivery.ts` branch on `exitCode !== 0`
    - This is the finding most likely to invalidate its own fix; do it before writing code
    - _Findings: F-14_
  - [ ] 12.2 Honour `timeoutMs` and give `stop()` a real meaning or an honest failure
    - `DEFAULT_TIMEOUT_MS` is declared and never read. With the no-op `stop()` the result is no
      ceiling, no cancel, no kill: a hung command bills to the 3600s idle timeout
    - _Findings: F-15_
  - [ ] 12.3 Add `set -e` to the prelude
    - Without it a failed `cd` runs the command anyway in the interpreter's home directory, which
      with F-14 can read as success
    - _Findings: F-16_
  - [ ] 12.4 Correct the session-reuse comment and the interpreter default
    - `StartCodeInterpreterSession` returns a fresh id per call and `name` is not an idempotency key,
      so the claimed retry-reaches-the-same-workspace property does not hold here even though it
      does in both siblings
    - Stop defaulting `codeInterpreterId` to `aws.codeinterpreter.v1`, which has no `git`
    - _Findings: F-20, F-21_
  - [ ] 12.5 Extract the duplicated shell session
    - `agentcore.ts` and `agentcore-runtime.ts` share near-identical `exec`, prelude, `writeFile`,
      `readFile`, `stop` and `shellQuote`, comments included. A fix to one heredoc does not reach the
      other. Extract a shared shell-only session base
    - Skip if D2 chose option B, which removes the duplication by deletion
    - _Findings: F-14, F-15, F-16_

- [ ] 13. BERR-76: substrate errors reach the run and the model
  - [ ] 13.1 Settle the `error` + `exit` protocol
    - The AgentCore drivers yield `error` then `exit 1`; `command-tool.ts` surfaces `error` only when
      `exitCode === null`, so `ThrottlingException`, `AccessDeniedException` and `TIMED_OUT` reach
      the model as "exit 1, no output" and the ledger as nothing. The docker driver emits `error`
      with no trailing `exit`, so one union carries two incompatible protocols
    - Fix it in `driver.ts` by saying which is correct, then make all three drivers and the one
      consumer agree
    - _Findings: F-17_
  - [ ] 13.2 Record the error text in the ledger
    - A substrate failure currently leaves no `run_events` row. An operator reading the run back has
      no way to tell a throttled command from one that ran and failed
    - _Findings: F-17_
  - [ ] 13.3 Tests
    - Each driver's error path produces both a model-visible message and a ledger row; a stream that
      ends without an exit is still not reported as success
    - _Findings: F-17_

- [ ] 14. BERR-77: wire `health()` into readiness, or remove it
  - [ ] 14.1 Decide and act
    - `health()` is implemented three times with care — `agentcore.ts` starts and stops a real
      session — and has zero callers. `/ready` probes only Postgres, so `driver.ts`'s "for readiness"
      is unfulfilled and `agentcore.ts`'s probe is unexercised cost
    - Either report execution reachability from `/ready` (and consider surfacing it in
      `GET /api/v1/config`, whose stated rule is that a capability reported true must be deliverable),
      or delete the three implementations
    - Same call for `ExecutionSession.stop()`, which has no caller and makes the sidecar's
      `POST /sessions/:id/stop` and `http.ts`'s `stop()` dead
    - _Findings: F-19_

- [ ] 15. Checkpoint — substrate
  - `pnpm typecheck:server`, `pnpm test:server`, and `python3 scripts/check-compose-config.py` if
    the runtime image or Compose pins moved. Exercise one real repository run under
    `BERRY_RUNTIME_DRIVER=agentcore-runtime`.

## Phase 5 — Classification and propagation (BERR-78 … BERR-80)

- [ ] 16. BERR-78: retry classification reads the AWS error shape
  - [ ] 16.1 Read `$metadata.httpStatusCode`
    - `failureCode` and `isRetryable` read `.status`, which AWS SDK v3 errors do not set, so a
      Bedrock 429 or 5xx classifies as non-retryable `RUNTIME_ERROR` — the throttling case these
      functions exist for. Confirm the field on a real `ThrottlingException` before relying on it
    - Keep `isRetryable` deliberately narrow: its comment is right that a retryable failure invites
      another paid run with side effects
    - _Findings: F-22_
  - [ ] 16.2 Decide what `retryable: true` means
    - Nothing retries. `DISPATCH_ABANDONED` is marked retryable, releases the task, and waits for a
      human. Either say so in the field's documentation, or add a retry with an attempt counter —
      there is no `attempt` column on `runs`, so a bounded retry needs one
    - _Findings: F-30_
  - [ ] 16.3 Test the mapping against a real error shape
    - Pin against a captured `ThrottlingException`, not a hand-written object with `.status`, or the
      test will assert the bug
    - _Findings: F-22_

- [ ] 17. BERR-79: a failed tool does not silently succeed
  - [ ] 17.1 Decide what `tool_completed(ok: false)` costs a run
    - Strands reports a thrown tool as a result with an error status, so the run continues and can
      still succeed. Nothing gates on `ok`. A `write_file` whose storage `put` failed is a
      false-success: the ledger shows a failed tool and the run shows succeeded
    - Failing the run on any tool error is probably too blunt — a non-zero `pnpm test` is a normal
      result the prompt explicitly tells the agent to act on. Distinguish a tool that *threw* from a
      command that *exited non-zero*
    - _Findings: F-23_
  - [ ] 17.2 Test both directions
    - A thrown `write_file` does not produce a succeeded run; a `run_command` exiting 1 still can
    - _Findings: F-23_

- [ ] 18. BERR-80: truncation keeps the sharper instruction
  - [ ] 18.1 Reserve room for review feedback and prior work
    - `buildMessage` reserves room for the contracts and cuts the tail, but the tail is
      `reviewFeedback` → `priorWork` → `Repository:`. A description long enough to fill 64 KB drops
      the review feedback the code calls "the sharper instruction" and the repository line, while
      fully retaining the description that caused the overflow
    - Truncate the description instead, which is what the comment at `prompt.ts:62-64` already claims
      happens
    - _Findings: F-24_
  - [ ] 18.2 Test the eviction order
    - `executor.test.ts:158` currently checks only that the contracts survive. Add: an oversized
      description does not evict `reviewFeedback`, `priorWork`, or the repository line
    - _Findings: F-24_

## Phase 6 — Residue and coverage (BERR-81 … BERR-83)

- [ ] 19. BERR-81: wire or remove the unused model configuration
  - [ ] 19.1 Fix the dropped credentials
    - `index.ts:219` spreads `credentials` into `AdkExecutor`; `ExecutorOptions` declares no such
      field, and spread properties escape excess-property checking, so it compiles and the value is
      discarded. The model picker uses the explicit credentials and runs fall back to the AWS default
      chain — which `agentcore.ts`'s own comment explains is actively wrong in Compose, where
      `AWS_ACCESS_KEY_ID` is MinIO's
    - Either declare and thread the field, or stop passing it. Do not leave a configured credential
      silently ignored
    - _Findings: F-25_
  - [ ] 19.2 Wire or drop `maxTokens` and `temperature`
    - Declared on `AgentRuntimeOptions`, never populated, so every run is 8192 tokens with no
      per-agent override
    - _Findings: F-25_
  - [ ] 19.3 Test that configured credentials reach the model call
    - The test that would have caught a spread-shaped hole: assert the value arrives, not that the
      option exists
    - _Findings: F-25_

- [ ] 20. BERR-82: remove the ADK-era residue and settle the naming
  - [ ] 20.1 Delete the dead code
    - `let streamed` (`executor.ts:315`, declared, never read, with a three-line comment describing
      ADK behaviour Strands does not have), `stillOpen()` (exported, no caller), and `artifactKey()`'s
      dummy `{appName, userId, sessionId}` triple
    - Consider enabling `noUnusedLocals` in `server-ts/tsconfig.json` so the next one fails the type
      gate rather than surviving review
    - _Findings: F-26_
  - [ ] 20.2 Remove the unreachable `cancel_requested` path
    - Read at `ledger.ts:204`, `:212`, `:429`, written nowhere. `RunCancelling` and `markRunning`'s
      cancel-survives-dispatch branch are unreachable, and the `RunCancelling` comment claims a
      guarantee its named mechanism does not provide — the race is closed by `markCancelled` going
      straight to terminal
    - Either write the state, or delete the readers and correct the comment. The columns
      `cancel_requested_at` / `cancel_requested_by` are also never written; leave them (forward-only)
      but stop implying they are load-bearing
    - _Findings: F-27_
  - [ ] 20.3 Correct the cancel contract comment
    - `mounts/runs.ts` says cancellation "returns the run as it stands, which may still be
      `running`". It cannot — `markCancelled` always commits terminal before returning. The honest
      version is that the row is terminal immediately while the model call may bill for up to one
      heartbeat
    - _Findings: F-28_
  - [ ] 20.4 Settle ADK versus Strands
    - The class is `AdkExecutor`, its comments say ADK, `artifact-service.ts` says "ADK artifacts",
      and `AGENTS.md` plus ADR-0008 both name the Google Agent Development Kit. The implementation is
      `@strands-agents/sdk`
    - Rename in code and correct the docs, or supersede ADR-0008 with an ADR recording the change.
      Do not leave the two disagreeing — it sends every reader looking for a runtime that is not
      there. Also clear the stale Cloudflare references in `runtime/protocol.ts`,
      `runtime/index.ts` and `config/config.ts`
    - _Findings: F-26_
  - [ ] 20.5 Fix the SCM factory fallthrough
    - `provider-factory.ts` returns a fully-null SCM when the gateway is configured but
      `startGateway` yields no provider, disabling repository work even though a working GitHub App
      exists. A discovery hiccup should fall back, not disable
    - _Findings: F-36_

- [ ] 21. BERR-83: cover the orchestration loop
  - [ ] 21.1 Test `AdkExecutor.run` against a fake agent stream
    - `executor.test.ts` covers only `ResultText`, `splitUtf8`, `toAgentName`, `buildMessage` and
      `recallPrompt`. The loop, cancellation, delivery ordering and permission enforcement are
      untested — which is why F-01 through F-04 survived
    - Drive `runAgent` with a recorded event sequence: text deltas coalesce into ledger deltas, tool
      pairs open and close, an abort mid-turn ends as cancelled, tools left open are closed, delivery
      runs before the workspace is destroyed
    - _Findings: F-31_
  - [ ] 21.2 Pin the Strands event mapping against a recorded payload
    - `translate()` is defensive by design but fails silently: a renamed SDK event yields no `usage`
      (cost silently 0) or no `text` (empty summary, no result comment, no memory record). Nothing
      asserts the five names against a real payload, and the SDK is young
    - _Findings: F-31_

- [ ] 22. Final checkpoint — run path
  - `pnpm typecheck:server` and `pnpm test:server` (both with and without `BERRY_TEST_DATABASE_URL`,
    migrations applied). Exercise one repository run end to end and confirm: commands appear in the
    board stream, artifacts appear in the commit, the PR opens, and cancelling mid-run stops the
    command rather than only the model call.

## Phase 7 — Design work, not yet approved

Each of these is a decision about what Berry should be, not a defect with an obvious fix. They are
listed so the register is complete, and deliberately have no tasks.

- [ ] 23. Prompt injection provenance (F-32)
  - Issue fields, `issue_auto_reviews.reason` (another model's output, wrapped in "Address that
    specifically"), Memory recall and tool returns all reach the model unlabelled and undelimited,
    and an empty system prompt is permitted. The agent then has `run_command` in a container with a
    checkout and `git push --force-with-lease` on its own branch
  - Mitigating this properly means marking provenance on every untrusted span, which changes every
    prompt and every test that pins one. The human PR gate is the current mitigation and sits
    downstream of everything the agent can do inside the container

- [ ] 24. Concurrency and cost ceilings (F-33)
  - Caps today: one active run per issue (a genuinely strong brake — no agent-reachable tool admits a
    run) and `BERRY_RUN_CONCURRENCY`, default 2, per process. Nothing per workspace, per agent,
    global, or per spend
  - `PlanTriage.triage` admits one run per plan task with no ceiling and swallows per-task failures,
    so a 200-task plan queues 200 runs. `cost_micros` is recorded and never checked, and
    `usage.costMicros` is always null despite `ModelCatalog` fetching per-token prices

- [ ] 25. Database-level run state machine (F-34)
  - No constraint relates old status to new, and none couples `status` to `dispatch_state`, so
    `status='running'` with `dispatch_state='pending'` is a legal row — which matters because the
    sweeper's whole discriminator is `dispatch_state <> 'pending'`. `runs_dispatch_state_ck` is
    `NOT VALID`, so existing rows were never checked
  - Every test fixture mutates status directly, so tightening this touches the suite as well as the
    schema

- [ ] 26. Secrets at the substrate boundary (F-39, F-40)
  - Inside Berry the invariant holds: `checkout.ts` passes the token as per-command env and gives git
    only the variable *name*, so `run.command.started` is safe to publish. Under both AgentCore
    drivers the prelude composes `export BERRY_GIT_TOKEN='ghs_…'` into the command string sent to
    AWS — base64-wrapped for the runtime driver, which defeats the tokenizer, not an observer
  - Separately, `CreateSessionInput.env` is documented as where secrets belong, but session env is
    re-exported into every command for the session's life (AgentCore) or becomes container `Env` an
    agent can `printenv` (docker). Latent, since `executor.ts` passes no `env` — but the interface
    recommends the unsafe path, so the fix is to the documentation and the type as much as the code

## Notes

- **One issue per PR.** BERR-66 through BERR-83 are eighteen separate branches, not a stack. Phase 1
  in particular should not be squashed: 1.x is a product-behaviour change needing a decision, 2.x is
  a durability fix, and 3.x is an authorization ordering fix. They share a directory and nothing else.
- **Phase 0 gates Phase 1.** D1 changes whether 1.1 or 1.3 is the fix. D2 decides whether BERR-75
  exists at all. D3 decides whether BERR-72 needs migration 053. D4 gates 6.2.
- **Migration numbering.** `052` is claimed by 5.1. If D3 produces a permission grant it is `053`.
  Allocate in the order the PRs merge, not the order they are written, and never edit `001`–`051`.
- **Three findings need live confirmation before their fix is trusted:** F-14 (does
  `InvokeCodeInterpreter` set `isError` for a non-zero shell exit), F-22 (the exact status field on a
  real Bedrock `ThrottlingException`), and the F-31 event mapping (that Strands emits exactly the five
  names `translate()` matches). Writing a test from the current code rather than from a captured
  payload would pin the bug.
- **Every DB-backed test self-skips** without `BERRY_TEST_DATABASE_URL`. A fresh `pnpm test:server`
  stays green offline; keep it that way.
- **The wire contract is additive-only here.** 6.3 adds `pageInfo.hasNextPage` to the run event page
  and 7.1 widens a replay allowlist. Cursors and idempotency fingerprints already issued must keep
  decoding, so no cursor envelope or canonical JSON form changes in this plan.
- **What this plan does not touch:** the frontend, the goals/projects/plans surfaces, the GitHub App
  lifecycle, and anything under `docs/` beyond ADR-0008 and the stale Cloudflare comments in 20.4.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["0.1", "0.2", "0.3", "0.4"] },
    { "id": 1, "tasks": ["1.1", "1.2", "1.3", "2.1", "2.2", "2.3", "2.4", "3.1", "3.2", "3.3"] },
    { "id": 2, "tasks": ["1.4", "2.5", "3.4"] },
    { "id": 3, "tasks": ["4"] },
    { "id": 4, "tasks": ["5.1", "6.1", "6.3", "7.1"] },
    { "id": 5, "tasks": ["5.2", "6.2", "7.2"] },
    { "id": 6, "tasks": ["8"] },
    { "id": 7, "tasks": ["9.1", "9.2", "9.3", "10.1", "10.2"] },
    { "id": 8, "tasks": ["9.4", "10.3"] },
    { "id": 9, "tasks": ["11.1", "12.1", "14.1"] },
    { "id": 10, "tasks": ["11.2", "12.2", "12.3", "12.4", "13.1"] },
    { "id": 11, "tasks": ["12.5", "13.2"] },
    { "id": 12, "tasks": ["13.3", "15"] },
    { "id": 13, "tasks": ["16.1", "16.2", "17.1", "18.1"] },
    { "id": 14, "tasks": ["16.3", "17.2", "18.2"] },
    { "id": 15, "tasks": ["19.1", "19.2", "20.1", "20.2", "20.3", "20.4", "20.5"] },
    { "id": 16, "tasks": ["19.3", "21.1", "21.2"] },
    { "id": 17, "tasks": ["22"] }
  ]
}
```
