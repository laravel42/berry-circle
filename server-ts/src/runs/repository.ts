import { randomUUID } from 'node:crypto';
import { toRFC3339, type Sql } from '../db/pool.ts';
import { NotFound } from '../identity/errors.ts';
import type { Run } from './ledger.ts';

/**
 * Reading the run ledger, and the one write that starts a run.
 *
 * The ledger next door owns everything a run does to itself once it exists —
 * transitions, events, usage. This owns the two things outside that: answering
 * what happened, and admitting a new one.
 */

export interface RunCursor {
   createdAt: string;
   id: string;
}

export interface RunFilter {
   status?: string | undefined;
   agentId?: string | undefined;
}

export class ActiveRunExists extends Error {
   override readonly name = 'ActiveRunExists';
   readonly runId: string;
   constructor(runId: string) {
      super('this task already has a run in progress');
      this.runId = runId;
   }
}

export class NoAgentAssigned extends Error {
   override readonly name = 'NoAgentAssigned';
   constructor() {
      super('this task has no agent assigned to run it');
   }
}

const RUN_COLUMNS = `r.id, r.issue_id, r.board_id, COALESCE(r.workspace_id, b.workspace_id) AS workspace_id, r.agent_id, r.status,
   r.sequence, r.summary, r.input_tokens, r.output_tokens, r.total_tokens, r.cost_micros,
   r.currency, r.failure_code, r.failure_message, r.failure_retryable, r.dispatch_state,
   r.source, r.requested_by,
   r.created_at, r.started_at, r.completed_at`;

// LEFT: a chat or completion run has no board.
const RUN_SOURCE = `FROM runs r LEFT JOIN boards b ON b.id = r.board_id`;

export class RunRepository {
   readonly #sql: Sql;
   readonly #newId: () => string;

   constructor(sql: Sql, newId: () => string = randomUUID) {
      this.#sql = sql;
      this.#newId = newId;
   }

   async get(runId: string): Promise<Run> {
      const [row] = await this.#sql`
         SELECT ${this.#sql.unsafe(RUN_COLUMNS)} ${this.#sql.unsafe(RUN_SOURCE)}
          WHERE r.id = ${runId}`;
      if (!row) throw new NotFound();
      return toRun(row);
   }

   /**
    * A board's runs, newest first.
    *
    * `(created_at DESC, id DESC)` with a strictly-less-than cursor, which is
    * what makes paging stable when several runs share a timestamp — the id
    * breaks the tie the same way in the order and in the cursor.
    */
   async listByBoard(
      boardId: string,
      after: RunCursor | null,
      limit: number,
      filter: RunFilter = {}
   ): Promise<Run[]> {
      const rows = await this.#sql`
         SELECT ${this.#sql.unsafe(RUN_COLUMNS)} ${this.#sql.unsafe(RUN_SOURCE)}
          WHERE r.board_id = ${boardId}
            AND (${filter.status == null} OR r.status = ${filter.status ?? null}::run_status)
            AND (${filter.agentId == null} OR r.agent_id = ${filter.agentId ?? null}::uuid)
            AND (${after === null} OR (r.created_at, r.id) < (${after?.createdAt ?? null}::timestamptz, ${after?.id ?? null}::uuid))
          ORDER BY r.created_at DESC, r.id DESC
          LIMIT ${limit}`;
      return rows.map(toRun);
   }

   async listByIssue(
      issueId: string,
      after: RunCursor | null,
      limit: number,
      filter: RunFilter = {}
   ): Promise<Run[]> {
      const rows = await this.#sql`
         SELECT ${this.#sql.unsafe(RUN_COLUMNS)} ${this.#sql.unsafe(RUN_SOURCE)}
          WHERE r.issue_id = ${issueId}
            AND (${filter.status == null} OR r.status = ${filter.status ?? null}::run_status)
            AND (${after === null} OR (r.created_at, r.id) < (${after?.createdAt ?? null}::timestamptz, ${after?.id ?? null}::uuid))
          ORDER BY r.created_at DESC, r.id DESC
          LIMIT ${limit}`;
      return rows.map(toRun);
   }

   /** One agent's runs across its workspace, newest first — the agent's task list. */
   async listByAgent(
      agentId: string,
      after: RunCursor | null,
      limit: number,
      filter: RunFilter = {}
   ): Promise<Run[]> {
      const rows = await this.#sql`
         SELECT ${this.#sql.unsafe(RUN_COLUMNS)} ${this.#sql.unsafe(RUN_SOURCE)}
          WHERE r.agent_id = ${agentId}
            AND (${filter.status == null} OR r.status = ${filter.status ?? null}::run_status)
            AND (${after === null} OR (r.created_at, r.id) < (${after?.createdAt ?? null}::timestamptz, ${after?.id ?? null}::uuid))
          ORDER BY r.created_at DESC, r.id DESC
          LIMIT ${limit}`;
      return rows.map(toRun);
   }

   /**
    * Admits a run: the assignment and the queued run, in one transaction.
    *
    * Both together or neither, because a run that exists against an issue
    * assigned to nobody cannot be dispatched and cannot be explained. The
    * `run.created` event is written here at sequence 0, which is why the
    * ledger's allocator starts at 1.
    *
    * Nothing is dispatched from here. A queued run is a durable fact; whether
    * a runtime later accepts it is the ledger's business, and a failure there
    * becomes a recorded `run.failed` rather than an HTTP error on a request
    * that already succeeded.
    */
   async admit(input: {
      issueId: string;
      boardId: string;
      workspaceId: string;
      agentId: string | null;
      requestedBy: string;
      instructions: string | null;
   }): Promise<Run> {
      const runId = this.#newId();

      return this.#sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;

         // Locked before anything is read, so two requests for the same issue
         // cannot both find no active run and both create one. The unique
         // index would catch the second, but as a constraint violation rather
         // than as the 409 the caller is owed.
         const [issue] = await tx`
            SELECT id, assignee_type, assignee_id, active_run_id
              FROM issues WHERE id = ${input.issueId} FOR UPDATE`;
         if (!issue) throw new NotFound();

         if (input.agentId !== null) {
            await tx`
               UPDATE issues
                  SET assignee_type = 'agent', assignee_id = ${input.agentId}, updated_at = now()
                WHERE id = ${input.issueId}`;
         }

         const agentId =
            input.agentId ??
            (issue.assignee_type === 'agent' ? (issue.assignee_id as string | null) : null);
         if (!agentId) throw new NoAgentAssigned();

         const [active] = await tx`
            SELECT id FROM runs
             WHERE issue_id = ${input.issueId} AND status IN ('queued', 'running')
             LIMIT 1`;
         if (active) throw new ActiveRunExists(active.id as string);

         await tx`
            INSERT INTO runs (id, issue_id, board_id, agent_id, instructions, requested_by)
            VALUES (${runId}, ${input.issueId}, ${input.boardId}, ${agentId},
                    ${input.instructions}, ${input.requestedBy})`;
         await tx`UPDATE issues SET active_run_id = ${runId} WHERE id = ${input.issueId}`;

         // Sequence 0, without the allocator: this is the event that starts the
         // sequence rather than one appended to it.
         await tx`
            INSERT INTO run_events (id, run_id, board_id, issue_id, sequence, event_type, payload, public)
            VALUES (${this.#newId()}, ${runId}, ${input.boardId}, ${input.issueId}, 0,
                    'run.created', ${tx.json({ agentId } as never)}, true)`;

         const [row] = await tx`
            SELECT ${tx.unsafe(RUN_COLUMNS)} ${tx.unsafe(RUN_SOURCE)} WHERE r.id = ${runId}`;
         return toRun(row!);
      });
   }

   /**
    * The public events of one run, in sequence order.
    *
    * `after` is exclusive, so a reconnecting reader passes the last sequence
    * it saw and receives what followed rather than a repeat of it.
    */
   async events(runId: string, after: number | null, limit: number): Promise<RunEventRow[]> {
      const rows = await this.#sql`
         SELECT id, run_id, board_id, issue_id, sequence, event_type, payload, occurred_at
           FROM run_events
          WHERE run_id = ${runId}
            AND public
            AND (${after === null} OR sequence > ${after ?? 0})
          ORDER BY sequence ASC
          LIMIT ${limit}`;
      return rows.map((row) => ({
         id: row.id as string,
         type: row.event_type as string,
         occurredAt: toRFC3339(row.occurred_at as string)!,
         boardId: row.board_id as string,
         issueId: row.issue_id as string,
         runId: row.run_id as string,
         sequence: Number(row.sequence),
         payload: row.payload as unknown,
      }));
   }
}

export interface RunEventRow {
   id: string;
   type: string;
   occurredAt: string;
   boardId: string;
   issueId: string;
   runId: string;
   sequence: number;
   payload: unknown;
}

function toRun(row: Record<string, unknown>): Run {
   return {
      id: row.id as string,
      issueId: row.issue_id as string,
      boardId: row.board_id as string,
      workspaceId: row.workspace_id as string,
      agentId: row.agent_id as string,
      status: row.status as Run['status'],
      sequence: Number(row.sequence),
      summary: (row.summary as string | null) ?? null,
      usage: {
         inputTokens: Number(row.input_tokens),
         outputTokens: Number(row.output_tokens),
         totalTokens: Number(row.total_tokens),
         costMicros: row.cost_micros === null ? null : Number(row.cost_micros),
         currency: (row.currency as string | null) ?? null,
      },
      // Present only when there is one: a failure with a null code is not a
      // failure, and the contract says the field is null unless status failed.
      failure:
         row.failure_code === null || row.failure_code === undefined
            ? null
            : {
                 code: row.failure_code as string,
                 message: (row.failure_message as string | null) ?? '',
                 retryable: Boolean(row.failure_retryable),
              },
      source: (row.source as string | null) ?? 'assignment',
      requestedBy: (row.requested_by as string | null) ?? null,
      dispatchState: row.dispatch_state as string,
      createdAt: toRFC3339(row.created_at as string)!,
      startedAt: toRFC3339(row.started_at as string | null),
      completedAt: toRFC3339(row.completed_at as string | null),
   };
}
