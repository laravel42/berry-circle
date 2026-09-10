import { randomUUID } from 'node:crypto';
import type { IssueRepository } from '../core/issues.ts';
import type { Sql } from '../db/pool.ts';
import { NotFound } from '../identity/errors.ts';
import { writeAutopilotEvent } from './events.ts';
import type { RunSource } from './repository.ts';
import { renderPrompt } from './template.ts';

/**
 * What happens when an autopilot fires — whichever way it was fired.
 *
 * Schedule, webhook, a person pressing "run now" and a replayed delivery all
 * come through here, so they share one set of rules: an archived autopilot
 * never runs, a paused one runs only by hand, a quota is a quota, and every
 * firing leaves a row saying what became of it.
 *
 * The row is written *before* the task is queued. The queue may want to point
 * back at it, and a crash between the two leaves a `pending` row a person can
 * see rather than a task with no record of why it exists.
 *
 * Nothing here throws for a reason that belongs to the autopilot. A trigger
 * that fired correctly has not failed because the queue said no; the run
 * record says so instead.
 */

/** The subset of workstream A's `enqueueTask` input an autopilot sends. */
export interface AutopilotTaskInput {
   workspaceId: string;
   agentId: string;
   issueId?: string;
   kind: 'agent';
   source: 'autopilot';
   prompt?: string;
   autopilotRunId?: string;
   priority?: number;
}

export type EnqueueTask = (sql: Sql, input: AutopilotTaskInput) => Promise<{ runId: string }>;
export type ResolveSquadLeader = (
   sql: Sql,
   workspaceId: string,
   squadId: string
) => Promise<string | null>;

export interface FireDeps {
   sql: Sql;
   issues: Pick<IssueRepository, 'create'>;
   enqueue: EnqueueTask;
   resolveSquadLeader: ResolveSquadLeader;
   clock?: () => Date;
}

export interface FireInput {
   autopilotId: string;
   source: RunSource;
   triggerId?: string | null;
   slot?: Date | null;
   payload?: unknown;
   requestedBy?: string | null;
}

export interface FireOutcome {
   autopilotRunId: string;
   status: 'enqueued' | 'skipped' | 'failed';
   reasonCode: string | null;
   runId: string | null;
   issueId: string | null;
}

export type FireFn = (input: FireInput) => Promise<FireOutcome>;

interface Reason {
   code: string;
   message: string;
}

interface Admitted {
   id: string;
   workspaceId: string;
   name: string;
   assigneeType: string;
   assigneeId: string;
   promptTemplate: string;
   executionMode: string;
   boardId: string | null;
   issueId: string | null;
   createdBy: string | null;
   skipped: Reason | null;
}

export async function fireAutopilot(deps: FireDeps, input: FireInput): Promise<FireOutcome> {
   const clock = deps.clock ?? (() => new Date());
   const firedAt = clock().toISOString();
   const autopilotRunId = randomUUID();
   const admitted = await admit(deps.sql, input, autopilotRunId, firedAt);
   if (admitted.skipped) {
      return {
         autopilotRunId,
         status: 'skipped',
         reasonCode: admitted.skipped.code,
         runId: null,
         issueId: null,
      };
   }

   let issueId: string | null = admitted.executionMode === 'fixed_issue' ? admitted.issueId : null;
   const fail = (reason: Reason) =>
      settle(deps.sql, admitted, autopilotRunId, firedAt, { status: 'failed', reason, runId: null, issueId });

   try {
      const agentId =
         admitted.assigneeType === 'agent'
            ? admitted.assigneeId
            : await deps.resolveSquadLeader(deps.sql, admitted.workspaceId, admitted.assigneeId);
      if (!agentId) {
         return await fail({
            code: 'SQUAD_UNAVAILABLE',
            message: 'The squad has no agent leading it, so there is nobody to hand the run to.',
         });
      }

      const prompt = renderPrompt(admitted.promptTemplate, {
         autopilot: { id: admitted.id, name: admitted.name },
         trigger: { source: input.source, firedAt },
         payload: input.payload ?? null,
      });

      if (admitted.executionMode === 'create_issue') {
         const owner = input.requestedBy ?? admitted.createdBy;
         if (!owner || !admitted.boardId) {
            return await fail({
               code: 'TARGET_MISSING',
               message: 'The board this autopilot opens tasks on, or the person it opens them as, no longer exists.',
            });
         }
         const created = await deps.issues.create({
            boardId: admitted.boardId,
            title: taskTitle(admitted.name, firedAt),
            description: prompt,
            status: 'todo',
            priority: 'none',
            sortOrder: 0,
            dueDate: null,
            assignee: { type: 'agent', id: agentId },
            project: null,
            createdBy: owner,
         });
         issueId = created.issue.id;
      } else if (!issueId) {
         return await fail({
            code: 'TARGET_MISSING',
            message: 'The task this autopilot works on was deleted.',
         });
      }

      const { runId } = await deps.enqueue(deps.sql, {
         workspaceId: admitted.workspaceId,
         agentId,
         issueId,
         kind: 'agent',
         source: 'autopilot',
         prompt,
         autopilotRunId,
      });
      return await settle(deps.sql, admitted, autopilotRunId, firedAt, {
         status: 'enqueued',
         reason: null,
         runId,
         issueId,
      });
   } catch (error) {
      return await fail({
         code: 'ENQUEUE_FAILED',
         message: error instanceof Error ? error.message : String(error),
      });
   }
}

async function admit(sql: Sql, input: FireInput, autopilotRunId: string, firedAt: string): Promise<Admitted> {
   return sql.begin(async (transaction) => {
      const tx = transaction as unknown as Sql;
      // Locked so two firings counting against one quota see each other.
      const [row] = await tx`SELECT * FROM autopilots WHERE id = ${input.autopilotId} FOR UPDATE`;
      if (!row) throw new NotFound();
      const skipped = await reasonToSkip(tx, row, input.source);
      const workspaceId = row.workspace_id as string;

      await tx`
         INSERT INTO autopilot_runs (
            id, workspace_id, autopilot_id, autopilot_version, trigger_id, source, status,
            reason_code, reason_message, slot, requested_by, created_at
         ) VALUES (
            ${autopilotRunId}, ${workspaceId}, ${row.id as string}, ${row.version as number},
            ${input.triggerId ?? null}, ${input.source}, ${skipped ? 'skipped' : 'pending'},
            ${skipped?.code ?? null}, ${skipped?.message ?? null},
            ${input.slot ? input.slot.toISOString() : null}, ${input.requestedBy ?? null}, ${firedAt}
         )`;
      if (skipped) {
         await writeAutopilotEvent(tx, {
            workspaceId,
            topic: 'autopilot.run.created',
            autopilotId: row.id as string,
            payload: { autopilotRunId, status: 'skipped', reasonCode: skipped.code },
            occurredAt: firedAt,
         });
      }
      return {
         id: row.id as string,
         workspaceId,
         name: row.name as string,
         assigneeType: row.assignee_type as string,
         assigneeId: row.assignee_id as string,
         promptTemplate: row.prompt_template as string,
         executionMode: row.execution_mode as string,
         boardId: (row.board_id as string | null) ?? null,
         issueId: (row.issue_id as string | null) ?? null,
         createdBy: (row.created_by as string | null) ?? null,
         skipped,
      };
   }) as Promise<Admitted>;
}

async function reasonToSkip(
   tx: Sql,
   row: Record<string, unknown>,
   source: RunSource
): Promise<Reason | null> {
   if (row.status === 'archived') return { code: 'ARCHIVED', message: 'The autopilot is archived.' };
   if (row.status === 'paused' && source !== 'manual') {
      return { code: 'PAUSED', message: 'The autopilot is paused.' };
   }
   const period = row.quota_period as string;
   const limit = row.quota_max as number | null;
   if (period !== 'none' && limit !== null) {
      const [used] = await tx`
         SELECT count(*)::int AS n FROM autopilot_runs
          WHERE autopilot_id = ${row.id as string}
            AND status IN ('pending', 'enqueued')
            AND created_at >= date_trunc(${period}::text, now())`;
      if (((used?.n as number | undefined) ?? 0) >= limit) {
         return {
            code: 'QUOTA_EXCEEDED',
            message: `The autopilot has used its ${limit} runs for this ${period}.`,
         };
      }
   }
   return null;
}

async function settle(
   sql: Sql,
   admitted: Admitted,
   autopilotRunId: string,
   firedAt: string,
   result: { status: 'enqueued' | 'failed'; reason: Reason | null; runId: string | null; issueId: string | null }
): Promise<FireOutcome> {
   await sql.begin(async (transaction) => {
      const tx = transaction as unknown as Sql;
      await tx`
         UPDATE autopilot_runs
            SET status = ${result.status},
                reason_code = ${result.reason?.code ?? null},
                reason_message = ${result.reason ? result.reason.message.slice(0, 2000) : null},
                run_id = ${result.runId},
                issue_id = ${result.issueId}
          WHERE id = ${autopilotRunId}`;
      await writeAutopilotEvent(tx, {
         workspaceId: admitted.workspaceId,
         topic: 'autopilot.run.created',
         autopilotId: admitted.id,
         payload: {
            autopilotRunId,
            status: result.status,
            reasonCode: result.reason?.code ?? null,
            runId: result.runId,
            issueId: result.issueId,
         },
         occurredAt: firedAt,
      });
   });
   return {
      autopilotRunId,
      status: result.status,
      reasonCode: result.reason?.code ?? null,
      runId: result.runId,
      issueId: result.issueId,
   };
}

/** `Morning report · 2026-09-10 07:00 UTC` — the name, then when. */
function taskTitle(name: string, firedAt: string): string {
   return `${name} · ${firedAt.slice(0, 16).replace('T', ' ')} UTC`;
}
