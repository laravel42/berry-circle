import { randomUUID } from 'node:crypto';
import type { Sql } from '../db/pool.ts';
import { NotFound } from '../identity/errors.ts';
import { ActiveRunExists } from './repository.ts';

/**
 * Admitting a task, from anywhere in Berry.
 *
 * Every trigger — assignment, a mention, a chat message, an autopilot tick, a
 * squad leader's delegation, a quick action, the agent builder, a completion —
 * writes the same durable row, and the dispatcher is the only thing that ever
 * starts one. That is what keeps "a runtime was down" a recorded failure
 * rather than an error on whatever request happened to trigger the work.
 */

export type TaskKind = 'agent' | 'completion';
export type TaskSource =
   | 'assignment'
   | 'mention'
   | 'chat'
   | 'autopilot'
   | 'squad'
   | 'quick_action'
   | 'builder'
   | 'completion';

export interface EnqueueTaskInput {
   workspaceId: string;
   agentId: string;
   issueId?: string;
   kind: TaskKind;
   source: TaskSource;
   prompt?: string;
   chatSessionId?: string;
   autopilotRunId?: string;
   priority?: number;
}

export class EnqueueRejected extends Error {
   override readonly name = 'EnqueueRejected';
   readonly code: 'TASK_TARGET_REQUIRED' | 'AGENT_NOT_IN_WORKSPACE';
   constructor(code: EnqueueRejected['code'], message: string) {
      super(message);
      this.code = code;
   }
}

export async function enqueueTask(sql: Sql, input: EnqueueTaskInput): Promise<{ runId: string }> {
   if (input.kind === 'agent' && !input.issueId && !input.chatSessionId) {
      throw new EnqueueRejected('TASK_TARGET_REQUIRED', 'an agent task needs an issue or a chat session');
   }
   const runId = randomUUID();
   await inTransaction(sql, async (tx) => {
      const [agent] = await tx`
         SELECT id, runtime_id FROM agents
          WHERE id = ${input.agentId} AND workspace_id = ${input.workspaceId} AND archived_at IS NULL`;
      if (!agent) {
         throw new EnqueueRejected('AGENT_NOT_IN_WORKSPACE', 'that agent is not in this workspace');
      }
      const runtimeId = await resolveRuntimeId(tx, input.workspaceId, (agent.runtime_id as string | null) ?? null);

      let boardId: string | null = null;
      const issueId = input.kind === 'agent' ? (input.issueId ?? null) : null;
      if (issueId) {
         // Locked first, so two triggers on one issue cannot both see it idle.
         const [issue] = await tx`
            SELECT i.id, i.board_id FROM issues i JOIN boards b ON b.id = i.board_id
             WHERE i.id = ${issueId} AND b.workspace_id = ${input.workspaceId} AND i.deleted_at IS NULL
             FOR UPDATE OF i`;
         if (!issue) throw new NotFound();
         boardId = issue.board_id as string;
         const [active] = await tx`
            SELECT id FROM runs WHERE issue_id = ${issueId} AND status IN ('queued', 'running') LIMIT 1`;
         if (active) throw new ActiveRunExists(active.id as string);
      }
      // Chat guard (workstream D). A session's tasks are serialized rather
      // than refused, so chat can queue several: the session row is locked so
      // two sends cannot both see it idle, a session from another workspace is
      // not found, and the dispatcher's claim holds a second task back until
      // the one ahead of it ends.
      if (input.chatSessionId) {
         const [session] = await tx`
            SELECT id FROM conversations
             WHERE id = ${input.chatSessionId} AND workspace_id = ${input.workspaceId}
             FOR UPDATE`;
         if (!session) throw new NotFound();
      }

      await tx`
         INSERT INTO runs (id, workspace_id, issue_id, board_id, agent_id, kind, source, prompt,
                           chat_session_id, autopilot_run_id, priority, runtime_id, instructions)
         VALUES (${runId}, ${input.workspaceId}, ${issueId}, ${boardId}, ${input.agentId},
                 ${input.kind}, ${input.source}, ${input.prompt ?? null},
                 ${input.chatSessionId ?? null}, ${input.autopilotRunId ?? null},
                 ${input.priority ?? 0}, ${runtimeId}, ${input.kind === 'agent' ? (input.prompt ?? null) : null})`;

      if (input.chatSessionId) {
         // The first queued task becomes the session's active one; the reply
         // hook advances it to the next when this one ends.
         await tx`
            UPDATE conversations SET active_run_id = ${runId}
             WHERE id = ${input.chatSessionId} AND active_run_id IS NULL`;
      }
      if (issueId && boardId) {
         await tx`UPDATE issues SET active_run_id = ${runId}, updated_at = now() WHERE id = ${issueId}`;
         await tx`
            INSERT INTO run_events (id, run_id, board_id, issue_id, sequence, event_type, payload, public)
            VALUES (${randomUUID()}, ${runId}, ${boardId}, ${issueId}, 0, 'run.created',
                    ${tx.json({ agentId: input.agentId, source: input.source } as never)}, true)`;
      }
   });
   return { runId };
}

/** The agent's runtime, else the workspace default, else its platform runtime, else none. */
async function resolveRuntimeId(tx: Sql, workspaceId: string, agentRuntimeId: string | null): Promise<string | null> {
   if (agentRuntimeId) return agentRuntimeId;
   const [row] = await tx`
      SELECT id FROM agent_runtimes
       WHERE workspace_id = ${workspaceId} AND status <> 'disabled'
       ORDER BY is_default DESC, (kind = 'platform') DESC, created_at ASC
       LIMIT 1`;
   return row ? (row.id as string) : null;
}

/**
 * Runs `work` in a transaction, or inside the caller's.
 *
 * postgres.js hands a transaction a handle with no `begin`; a caller that
 * needs the task and its own writes to commit together (runCompletion writes
 * the completion spec beside the row) passes that handle here.
 */
async function inTransaction(sql: Sql, work: (tx: Sql) => Promise<void>): Promise<void> {
   const begin = (sql as unknown as { begin?: unknown }).begin;
   if (typeof begin === 'function') {
      await sql.begin(async (transaction) => work(transaction as unknown as Sql));
      return;
   }
   await work(sql);
}
