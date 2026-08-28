import { randomUUID } from 'node:crypto';
import { toRFC3339, type Sql } from '../db/pool.ts';

/**
 * The run ledger.
 *
 * Berry records what an agent did as an append-only sequence of events per
 * run, and the run row is a projection of that sequence. Moving execution
 * in-process changed who produces the events; it did not change the ledger,
 * because the ledger is a product surface — the run stream, the task timeline
 * and the peer reviewer all read it.
 *
 * Three invariants are carried over deliberately, because each of them is load
 * bearing and none is obvious from the table definition:
 *
 *   - Every append locks the run row first. The sequence is allocated by
 *     `berry_allocate_run_event_sequence`, which is an UPDATE on `runs`, so the
 *     lock is what serialises two appenders rather than letting both read the
 *     same number.
 *   - `occurred_at` is never simply "now". It is `GREATEST(now, last + 1µs)`,
 *     so replay by time agrees with replay by sequence. Two events written in
 *     the same microsecond would otherwise be returned in either order.
 *   - Each event is written twice in one transaction: to `run_events`, which
 *     is the durable history, and to `outbox_events`, which the worker relays
 *     to connected browsers. Publishing outside the transaction would announce
 *     facts that could still roll back.
 */

export class RunNotFound extends Error {
   constructor() {
      super('run not found');
      this.name = 'RunNotFound';
   }
}

/** The run already reached a terminal status; nothing more may be appended. */
export class RunTerminal extends Error {
   constructor() {
      super('run is terminal');
      this.name = 'RunTerminal';
   }
}

export class RunConflict extends Error {
   constructor() {
      super('run is not in the expected state');
      this.name = 'RunConflict';
   }
}

/**
 * A cancellation was requested and has not been confirmed.
 *
 * It outranks a clean end of stream: without this the cancel would race the
 * success commit, and the run would read as succeeded with a cut-off report
 * posted as its result.
 */
export class RunCancelling extends Error {
   constructor() {
      super('run is cancelling');
      this.name = 'RunCancelling';
   }
}

export interface Usage {
   inputTokens: number;
   outputTokens: number;
   totalTokens: number;
   costMicros: number | null;
   currency: string | null;
}

export interface Failure {
   code: string;
   message: string;
   retryable: boolean;
}

export interface Run {
   id: string;
   issueId: string;
   boardId: string;
   workspaceId: string;
   agentId: string;
   status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
   sequence: number;
   summary: string | null;
   usage: Usage;
   failure: Failure | null;
   dispatchState: string;
   createdAt: string;
   startedAt: string | null;
   completedAt: string | null;
}

/** Everything an executor needs to run one agent, from `ClaimDispatch`. */
export interface Dispatch {
   runId: string;
   issueId: string;
   boardId: string;
   workspaceId: string;
   agentId: string;
   issueTitle: string;
   issueDescription: string | null;
   issueIdentifier: string;
   /** Per-run instructions, set when the run was created. */
   instructions: string | null;
   /** The repository the work belongs in, reached through the issue's project. */
   repository: string;
   requestId: string;
   traceParent: string;
}

export interface LedgerOptions {
   sql: Sql;
   clock?: () => Date;
   newId?: () => string;
}

export class RunLedger {
   private readonly sql: Sql;
   private readonly clock: () => Date;
   private readonly newId: () => string;

   constructor(options: LedgerOptions) {
      this.sql = options.sql;
      this.clock = options.clock ?? (() => new Date());
      this.newId = options.newId ?? randomUUID;
   }

   /**
    * Claims the right to execute one run, exactly once.
    *
    * The claim is the guard against two workers running the same agent: a run
    * leaves `pending` once, and a second claimant is refused rather than
    * queued. Duplicating a dispatch would duplicate paid model calls and every
    * side effect the agent's tools have.
    */
   async claimDispatch(runId: string): Promise<Dispatch> {
      const now = this.clock().toISOString();
      return this.sql.begin(async (tx) => {
         const run = await lockRun(tx as unknown as Sql, runId);
         if (isTerminal(run.status)) throw new RunTerminal();
         if (run.status !== 'queued' || run.dispatchState !== 'pending') throw new RunConflict();

         await tx`
            UPDATE runs
               SET dispatch_state = 'dispatching',
                   dispatch_version = dispatch_version + 1,
                   dispatch_attempted_at = ${now},
                   updated_at = ${now}
             WHERE id = ${runId}`;

         const [row] = await tx`
            SELECT r.id, r.issue_id, r.board_id, r.agent_id,
                   i.title, i.description, r.instructions, r.request_id, r.traceparent,
                   b.workspace_id,
                   COALESCE(project.github_repo_full_name, '') AS repository,
                   berry_issue_identifier(b.workspace_id, i.number) AS identifier
              FROM runs AS r
              JOIN issues AS i ON i.id = r.issue_id
              JOIN boards AS b ON b.id = r.board_id
              -- Left joins throughout: an issue in no project, or a project
              -- naming no repository, still dispatches — it just carries no
              -- code context.
              LEFT JOIN issue_project_links AS link ON link.issue_id = i.id
              LEFT JOIN projects AS project
                ON project.id = link.project_id AND project.deleted_at IS NULL
             WHERE r.id = ${runId}`;
         if (!row) throw new RunNotFound();

         return {
            runId: row.id as string,
            issueId: row.issue_id as string,
            boardId: row.board_id as string,
            workspaceId: row.workspace_id as string,
            agentId: row.agent_id as string,
            issueTitle: row.title as string,
            issueDescription: (row.description as string | null) ?? null,
            issueIdentifier: row.identifier as string,
            instructions: (row.instructions as string | null) ?? null,
            repository: (row.repository as string) ?? '',
            requestId: (row.request_id as string | null) ?? '',
            traceParent: (row.traceparent as string | null) ?? '',
         };
      }) as Promise<Dispatch>;
   }

   /**
    * Records that the agent actually started.
    *
    * Deliberately separate from the claim: this used to wait for a valid
    * stream, and it keeps the same meaning here — a run is `running`
    * once the model accepted the request, not once Berry decided to send it.
    */
   async markRunning(runId: string): Promise<Run> {
      const now = this.clock().toISOString();
      return this.sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;
         const run = await lockRun(tx, runId);
         if (isTerminal(run.status)) throw new RunTerminal();
         if (
            run.status !== 'queued' ||
            (run.dispatchState !== 'dispatching' && run.dispatchState !== 'cancel_requested')
         ) {
            throw new RunConflict();
         }
         // A cancellation requested during dispatch survives the transition:
         // the run starts, and the cancel is confirmed against a running run
         // rather than lost.
         const dispatchState =
            run.dispatchState === 'cancel_requested' ? 'cancel_requested' : 'streaming';

         await tx`
            UPDATE runs
               SET status = 'running',
                   started_at = COALESCE(started_at, ${now}),
                   dispatch_state = ${dispatchState},
                   dispatch_accepted_at = ${now},
                   updated_at = ${now}
             WHERE id = ${runId}`;

         const sequence = await allocateSequence(tx, runId);
         const [at] = await eventTimes(tx, runId, now, 1);
         const started: Run = {
            ...run,
            status: 'running',
            sequence,
            startedAt: toRFC3339(now),
            dispatchState,
         };
         await this.appendEvent(tx, started, {
            id: this.newId(),
            type: 'run.started',
            sequence,
            occurredAt: at!,
            payload: { startedAt: toRFC3339(now) },
         });
         return started;
      }) as Promise<Run>;
   }

   /** One display delta, appended to the run's accumulated output. */
   async appendOutput(runId: string, channel: string, text: string): Promise<void> {
      await this.appendActiveEvent(
         runId,
         'run.output.delta',
         { channel, text },
         async (tx, now) => {
            // Bounded in SQL rather than in memory: the column holds the whole
            // transcript and a runaway agent must not be able to grow a row
            // without limit.
            await tx`
               UPDATE runs
                  SET output = left(output || ${text}, 1048576), updated_at = ${now}
                WHERE id = ${runId}`;
         }
      );
   }

   /** Only the tool's name and call id. Arguments are never recorded. */
   async appendToolStarted(runId: string, toolCallId: string, name: string): Promise<void> {
      await this.appendActiveEvent(runId, 'run.tool.started', {
         toolCallId,
         name,
         inputSummary: null,
      });
   }

   /** Only the outcome. Tool output is never recorded. */
   async appendToolCompleted(runId: string, toolCallId: string, succeeded: boolean): Promise<void> {
      await this.appendActiveEvent(runId, 'run.tool.completed', {
         toolCallId,
         status: succeeded ? 'succeeded' : 'failed',
         outputSummary: null,
      });
   }

   /**
    * A command an agent ran, recorded verbatim.
    *
    * The deliberate exception to the two methods above. A tool's arguments stay
    * out of the ledger because they are the agent's working notes; a command is
    * the product surface. An operator reading a run back weeks later has to be
    * able to see what ran, and "the agent used a tool" does not answer that.
    *
    * `commandId` ties the three events together, because output from two
    * commands can interleave when one is still draining as the next begins.
    */
   async appendCommandStarted(
      runId: string,
      params: { commandId: string; command: string; cwd: string | null }
   ): Promise<void> {
      await this.appendActiveEvent(runId, 'run.command.started', {
         commandId: params.commandId,
         command: params.command,
         cwd: params.cwd,
      });
   }

   /**
    * Output as it arrives, on the stream it was written to.
    *
    * Deliberately not added to `runs.output`. That column is the agent's own
    * prose and is what the result comment is built from; a hundred lines of
    * test output appended to it would become the answer posted on the task.
    */
   async appendCommandOutput(
      runId: string,
      params: { commandId: string; stream: 'stdout' | 'stderr'; text: string }
   ): Promise<void> {
      await this.appendActiveEvent(runId, 'run.command.output', {
         commandId: params.commandId,
         stream: params.stream,
         text: params.text,
      });
   }

   /** How the command ended. `exitCode` is null only when it never reported one. */
   async appendCommandCompleted(
      runId: string,
      params: {
         commandId: string;
         exitCode: number | null;
         durationMs: number;
         truncated: boolean;
      }
   ): Promise<void> {
      await this.appendActiveEvent(runId, 'run.command.completed', {
         commandId: params.commandId,
         exitCode: params.exitCode,
         durationMs: params.durationMs,
         // Says so rather than letting a reader assume they have the whole log.
         truncated: params.truncated,
      });
   }

   /**
    * The repository this run will work in, once it is in the workspace.
    *
    * Written before the agent starts, so a person opening a run that is still
    * cloning sees which repository it is waiting on rather than an empty log.
    */
   async appendRepositoryReady(
      runId: string,
      params: { repository: string; branch: string; baseCommit: string }
   ): Promise<void> {
      await this.appendActiveEvent(runId, 'run.repository.ready', {
         repository: params.repository,
         branch: params.branch,
         baseCommit: params.baseCommit,
      });
   }

   /**
    * The project's checks, run against the tree the run is about to push.
    *
    * Recorded whether they passed or not: the reviewer is the point, and a
    * failing check they can see is worth more than a pull request that never
    * arrived. `passed: false` is evidence, not an error.
    */
   async appendVerified(
      runId: string,
      params: {
         passed: boolean;
         complete: boolean;
         durationMs: number;
         results: Array<{
            command: string;
            exitCode: number | null;
            passed: boolean;
            durationMs: number;
            error: string | null;
         }>;
      }
   ): Promise<void> {
      await this.appendActiveEvent(runId, 'run.verified', {
         passed: params.passed,
         complete: params.complete,
         durationMs: params.durationMs,
         // Output is deliberately absent: it is in the pull request body where
         // a reviewer reads it, and a ledger row per test log would make the
         // run stream unreadable.
         results: params.results,
      });
   }

   /**
    * What the run delivered, or that it delivered nothing.
    *
    * `committed: false` is a legitimate outcome and is recorded as one — an
    * agent that answered a question changed no files, and a run that says so
    * is more useful than one that looks like it half-failed.
    */
   async appendDelivered(
      runId: string,
      params: {
         committed: boolean;
         commit: string | null;
         branch: string;
         filesChanged: number;
         insertions: number;
         deletions: number;
         files: string[];
         pullRequest: { number: number; url: string; created: boolean } | null;
      }
   ): Promise<void> {
      await this.appendActiveEvent(runId, 'run.delivered', { ...params });
   }

   /**
    * Terminal success: usage, the summary, and the task moved to review.
    *
    * Three events in one transaction — usage, completion, and the issue update
    * that tells every open board the task moved. Splitting them would let a
    * browser show a finished run on a task still marked in progress.
    */
   async completeSuccess(params: {
      runId: string;
      summary: string | null;
      usage: Usage;
   }): Promise<Run> {
      const now = this.clock().toISOString();
      return this.sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;
         const run = await lockRun(tx, params.runId);
         if (isTerminal(run.status)) throw new RunTerminal();
         if (run.dispatchState === 'cancel_requested') throw new RunCancelling();

         await tx`
            UPDATE runs
               SET status = 'succeeded',
                   summary = ${params.summary},
                   input_tokens = ${params.usage.inputTokens},
                   output_tokens = ${params.usage.outputTokens},
                   total_tokens = ${params.usage.totalTokens},
                   cost_micros = ${params.usage.costMicros},
                   currency = ${params.usage.currency},
                   failure_code = NULL,
                   failure_message = NULL,
                   failure_retryable = NULL,
                   dispatch_state = 'succeeded',
                   completed_at = ${now},
                   updated_at = ${now}
             WHERE id = ${params.runId}`;

         // Guarded on active_run_id so a run that is no longer the issue's
         // active one cannot move a task someone else already moved.
         await tx`
            UPDATE issues
               SET status = 'in_review', active_run_id = NULL, updated_at = ${now}
             WHERE id = ${run.issueId} AND active_run_id = ${run.id}`;

         const usageSequence = await allocateSequence(tx, run.id);
         const completedSequence = await allocateSequence(tx, run.id);
         const [usageAt, completedAt, issueAt] = await eventTimes(tx, run.id, now, 3);

         const completed: Run = {
            ...run,
            status: 'succeeded',
            sequence: completedSequence,
            summary: params.summary,
            usage: params.usage,
            failure: null,
            dispatchState: 'succeeded',
            completedAt: toRFC3339(now),
         };

         await this.appendEvent(tx, completed, {
            id: this.newId(),
            type: 'run.usage.updated',
            sequence: usageSequence,
            occurredAt: usageAt!,
            payload: { usage: serializeUsage(params.usage) },
         });
         await this.appendEvent(tx, completed, {
            id: this.newId(),
            type: 'run.completed',
            sequence: completedSequence,
            occurredAt: completedAt!,
            payload: { run: serializeRun(completed) },
         });
         await this.appendIssueUpdated(tx, completed, issueAt!);
         return completed;
      }) as Promise<Run>;
   }

   /**
    * Terminal failure.
    *
    * `reconcile` marks a run whose upstream state is unknown — a dispatch that
    * may or may not have reached the model. It parks the run for an operator
    * instead of retrying, because retrying an ambiguous dispatch is how one
    * task becomes two agents doing the same work.
    */
   async fail(params: { runId: string; failure: Failure; reconcile?: boolean }): Promise<Run> {
      const now = this.clock().toISOString();
      return this.sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;
         const run = await lockRun(tx, params.runId);
         if (isTerminal(run.status)) throw new RunTerminal();

         const dispatchState = params.reconcile ? 'reconciliation_required' : 'failed';
         await tx`
            UPDATE runs
               SET status = 'failed',
                   failure_code = ${params.failure.code},
                   failure_message = ${params.failure.message},
                   failure_retryable = ${params.failure.retryable},
                   dispatch_state = ${dispatchState},
                   reconciliation_required_at = ${params.reconcile ? now : null},
                   reconciliation_reason = ${params.reconcile ? params.failure.code : null},
                   completed_at = ${now},
                   updated_at = ${now}
             WHERE id = ${params.runId}`;
         await tx`
            UPDATE issues SET active_run_id = NULL, updated_at = ${now}
             WHERE id = ${run.issueId} AND active_run_id = ${run.id}`;

         const sequence = await allocateSequence(tx, run.id);
         const [at] = await eventTimes(tx, run.id, now, 1);
         const failed: Run = {
            ...run,
            status: 'failed',
            sequence,
            failure: params.failure,
            dispatchState,
            completedAt: toRFC3339(now),
         };
         await this.appendEvent(tx, failed, {
            id: this.newId(),
            type: 'run.failed',
            sequence,
            occurredAt: at!,
            payload: { run: serializeRun(failed) },
         });
         return failed;
      }) as Promise<Run>;
   }

   /** Idempotent: cancelling an already-cancelled run is what the caller wanted. */
   async markCancelled(runId: string): Promise<Run> {
      const now = this.clock().toISOString();
      return this.sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;
         const run = await lockRun(tx, runId);
         if (run.status === 'cancelled') return run;
         if (run.status === 'succeeded' || run.status === 'failed') throw new RunTerminal();

         await tx`
            UPDATE runs
               SET status = 'cancelled',
                   dispatch_state = 'cancelled',
                   cancel_completed_at = ${now},
                   completed_at = ${now},
                   updated_at = ${now}
             WHERE id = ${runId}`;
         await tx`
            UPDATE issues SET active_run_id = NULL, updated_at = ${now}
             WHERE id = ${run.issueId} AND active_run_id = ${run.id}`;

         const sequence = await allocateSequence(tx, run.id);
         const [at] = await eventTimes(tx, run.id, now, 1);
         const cancelled: Run = {
            ...run,
            status: 'cancelled',
            sequence,
            dispatchState: 'cancelled',
            completedAt: toRFC3339(now),
         };
         await this.appendEvent(tx, cancelled, {
            id: this.newId(),
            type: 'run.cancelled',
            sequence,
            occurredAt: at!,
            payload: { run: serializeRun(cancelled) },
         });
         return cancelled;
      }) as Promise<Run>;
   }

   /**
    * One event on a run that must still be running.
    *
    * Refusing on a terminal run is the point: an output delta arriving after a
    * cancellation is work from a stream that should have stopped, and
    * recording it would extend a run that is already closed.
    */
   private async appendActiveEvent(
      runId: string,
      eventType: string,
      payload: Record<string, unknown>,
      mutate?: (tx: Sql, now: string) => Promise<void>
   ): Promise<void> {
      const now = this.clock().toISOString();
      await this.sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;
         const run = await lockRun(tx, runId);
         if (isTerminal(run.status) || run.status !== 'running') throw new RunTerminal();
         if (mutate) await mutate(tx, now);

         const sequence = await allocateSequence(tx, runId);
         const [at] = await eventTimes(tx, runId, now, 1);
         await this.appendEvent(tx, { ...run, sequence }, {
            id: this.newId(),
            type: eventType,
            sequence,
            occurredAt: at!,
            payload,
         });
      });
   }

   /**
    * The durable row and its relay copy, always together.
    *
    * The envelope is passed as an object rather than as pre-serialised text
    * cast with `::jsonb`. Casting text stores a jsonb *string* — the whole
    * envelope quoted and escaped — which every consumer then fails to decode,
    * and which reads as valid jsonb to anything that only checks the column
    * type.
    */
   private async appendEvent(
      tx: Sql,
      run: Run,
      event: {
         id: string;
         type: string;
         sequence: number;
         occurredAt: string;
         payload: Record<string, unknown>;
      }
   ): Promise<void> {
      await tx`
         INSERT INTO run_events (
            id, run_id, board_id, issue_id, sequence, event_type, payload, public, occurred_at
         ) VALUES (
            ${event.id}, ${run.id}, ${run.boardId}, ${run.issueId}, ${event.sequence},
            ${event.type}, ${tx.json(event.payload as never)}, true, ${event.occurredAt}
         )`;

      await tx`
         INSERT INTO outbox_events (
            id, topic, aggregate_type, aggregate_id, workspace_id, board_id,
            payload, occurred_at, available_at
         ) VALUES (
            ${event.id}, ${event.type}, 'run', ${run.id}, ${run.workspaceId}, ${run.boardId},
            ${tx.json({
               id: event.id,
               type: event.type,
               occurredAt: toRFC3339(event.occurredAt),
               workspaceId: run.workspaceId,
               boardId: run.boardId,
               issueId: run.issueId,
               runId: run.id,
               sequence: event.sequence,
               payload: event.payload,
            } as never)},
            ${event.occurredAt}, ${event.occurredAt}
         )`;
   }

   /**
    * The `issue.updated` a finished run causes.
    *
    * Relay only — there is no `run_events` row, because this is a fact about
    * the issue rather than a step of the run. Boards that never opened the run
    * still have to see the task move.
    */
   private async appendIssueUpdated(tx: Sql, run: Run, occurredAt: string): Promise<void> {
      const [row] = await tx`
         SELECT i.id, i.board_id, i.number, i.title, i.description,
                i.status::text AS status, i.priority::text AS priority, i.sort_order, i.due_date,
                i.assignee_type::text AS assignee_type, i.assignee_id,
                COALESCE(assignee_user.name, assignee_agent.name) AS assignee_name,
                COALESCE(assignee_user.avatar_url, assignee_agent.avatar_url) AS assignee_avatar,
                i.active_run_id,
                i.created_by, creator.name AS creator_name, creator.avatar_url AS creator_avatar,
                i.created_at, i.updated_at,
                berry_issue_identifier(b.workspace_id, i.number) AS identifier,
                b.workspace_id
           -- Deliberately not filtered on i.deleted_at: this describes an
           -- event a run already emitted, and a run whose issue was deleted
           -- still has a history.
           FROM issues AS i
           JOIN boards AS b ON b.id = i.board_id
           LEFT JOIN users AS assignee_user
             ON i.assignee_type = 'user' AND assignee_user.id = i.assignee_id
           LEFT JOIN agents AS assignee_agent
             ON i.assignee_type = 'agent' AND assignee_agent.id = i.assignee_id
           LEFT JOIN users AS creator ON creator.id = i.created_by
          WHERE i.id = ${run.issueId}`;
      if (!row) throw new RunNotFound();

      const id = this.newId();
      const payload = {
         issue: {
            id: row.id,
            boardId: row.board_id,
            number: Number(row.number),
            identifier: row.identifier,
            title: row.title,
            description: (row.description as string | null) ?? null,
            status: issueStatusToApi(row.status as string),
            priority: row.priority,
            sortOrder: Number(row.sort_order),
            dueDate: toRFC3339(row.due_date as string | null),
            assignee: row.assignee_type
               ? {
                    type: row.assignee_type,
                    id: row.assignee_id,
                    // The fallback names Go uses when the row is gone: an
                    // event that names nobody is worse than one that admits it.
                    name:
                       (row.assignee_name as string | null) ??
                       (row.assignee_type === 'user' ? 'Unknown user' : 'Agent'),
                    avatarUrl: (row.assignee_avatar as string | null) ?? null,
                 }
               : null,
            activeRunId: (row.active_run_id as string | null) ?? null,
            createdBy: row.created_by
               ? {
                    type: 'user',
                    id: row.created_by,
                    name: (row.creator_name as string | null) ?? 'Unknown user',
                    avatarUrl: (row.creator_avatar as string | null) ?? null,
                 }
               : null,
            createdAt: toRFC3339(row.created_at as string),
            updatedAt: toRFC3339(row.updated_at as string),
         },
         changedFields: ['activeRunId', 'status'],
      };

      await tx`
         INSERT INTO outbox_events (
            id, topic, aggregate_type, aggregate_id, workspace_id, board_id,
            payload, occurred_at, available_at
         ) VALUES (
            ${id}, 'issue.updated', 'issue', ${run.issueId}, ${run.workspaceId}, ${run.boardId},
            ${tx.json({
               id,
               type: 'issue.updated',
               occurredAt: toRFC3339(occurredAt),
               workspaceId: run.workspaceId,
               boardId: run.boardId,
               issueId: run.issueId,
               runId: run.id,
               sequence: null,
               payload,
            } as never)},
            ${occurredAt}, ${occurredAt}
         )`;
   }
}

/**
 * Loads and locks one run.
 *
 * The lock is not incidental. `berry_allocate_run_event_sequence` updates the
 * run row, so holding the row lock from the start of the transaction is what
 * makes two concurrent appends queue instead of colliding on
 * `run_events (run_id, sequence)`.
 */
async function lockRun(tx: Sql, runId: string): Promise<Run> {
   const [row] = await tx`
      SELECT r.id, r.issue_id, r.board_id,
             (SELECT b.workspace_id FROM boards AS b WHERE b.id = r.board_id) AS workspace_id,
             r.agent_id, r.status::text AS status, r.sequence, r.summary,
             r.input_tokens, r.output_tokens, r.total_tokens, r.cost_micros, r.currency,
             r.failure_code, r.failure_message, r.failure_retryable,
             r.dispatch_state, r.created_at, r.started_at, r.completed_at
        FROM runs AS r
       WHERE r.id = ${runId}
       FOR UPDATE`;
   if (!row) throw new RunNotFound();

   return {
      id: row.id as string,
      issueId: row.issue_id as string,
      boardId: row.board_id as string,
      workspaceId: row.workspace_id as string,
      agentId: row.agent_id as string,
      status: row.status as Run['status'],
      // bigint arrives as text, and a sequence on the wire is a number.
      sequence: Number(row.sequence),
      summary: (row.summary as string | null) ?? null,
      usage: {
         inputTokens: Number(row.input_tokens),
         outputTokens: Number(row.output_tokens),
         totalTokens: Number(row.total_tokens),
         costMicros: row.cost_micros === null ? null : Number(row.cost_micros),
         currency: (row.currency as string | null) ?? null,
      },
      failure:
         row.failure_code === null
            ? null
            : {
                 code: row.failure_code as string,
                 message: (row.failure_message as string | null) ?? '',
                 retryable: Boolean(row.failure_retryable),
              },
      dispatchState: row.dispatch_state as string,
      createdAt: toRFC3339(row.created_at as string) ?? '',
      startedAt: toRFC3339(row.started_at as string | null),
      completedAt: toRFC3339(row.completed_at as string | null),
   };
}

async function allocateSequence(tx: Sql, runId: string): Promise<number> {
   const [row] = await tx`SELECT berry_allocate_run_event_sequence(${runId}) AS sequence`;
   if (!row) throw new RunNotFound();
   return Number(row.sequence);
}

/**
 * `count` consecutive event times, each a microsecond after the last.
 *
 * The arithmetic stays in PostgreSQL because the unit is a microsecond and a
 * JavaScript Date holds milliseconds: adding 1µs in JS adds nothing at all,
 * and the ordering these timestamps exist to guarantee would silently not
 * hold.
 */
async function eventTimes(tx: Sql, runId: string, now: string, count: number): Promise<string[]> {
   const [row] = await tx`
      SELECT GREATEST(
                ${now}::timestamptz,
                COALESCE(MAX(occurred_at) + INTERVAL '1 microsecond', ${now}::timestamptz)
             ) AS base
        FROM run_events WHERE run_id = ${runId}`;
   const base = row!.base as string;
   if (count === 1) return [base];

   const [offsets] = await tx`
      SELECT array_agg(${base}::timestamptz + (step * INTERVAL '1 microsecond') ORDER BY step) AS times
        FROM generate_series(0, ${count - 1}) AS step`;
   return offsets!.times as string[];
}

function isTerminal(status: Run['status']): boolean {
   return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

function serializeUsage(usage: Usage): Record<string, unknown> {
   return {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      costMicros: usage.costMicros,
      currency: usage.currency,
   };
}

/** The run as the frontend receives it inside a lifecycle event. */
function serializeRun(run: Run): Record<string, unknown> {
   return {
      id: run.id,
      issueId: run.issueId,
      agentId: run.agentId,
      status: run.status,
      sequence: run.sequence,
      summary: run.summary,
      usage: serializeUsage(run.usage),
      failure: run.failure,
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
   };
}

/** `in_review` on the wire is `inReview`; the column keeps snake_case. */
export function issueStatusToApi(value: string): string {
   if (value === 'in_progress') return 'inProgress';
   if (value === 'in_review') return 'inReview';
   return value;
}
