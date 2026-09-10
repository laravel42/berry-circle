import { z } from 'zod';
import { toRFC3339, type Queryable, type Sql } from '../db/pool.ts';
import { Forbidden, NotFound } from '../identity/errors.ts';

/**
 * Workspace prompt templates run on an issue as an agent task.
 *
 * `QuickActionEnqueue` mirrors workstream A's `enqueueTask`
 * (`runs/queue.ts`). It is a parameter so this module compiles and is tested
 * before A merges; `index.ts` passes the real function.
 */
export type QuickActionEnqueue = (
   sql: Sql,
   input: {
      workspaceId: string;
      agentId: string;
      issueId?: string;
      kind: 'agent' | 'completion';
      source: 'assignment' | 'mention' | 'chat' | 'autopilot' | 'squad' | 'quick_action' | 'builder' | 'completion';
      prompt?: string;
      chatSessionId?: string;
      autopilotRunId?: string;
      priority?: number;
   }
) => Promise<{ runId: string }>;

export const quickActionCreateSchema = z
   .object({
      name: z.string().trim().min(1).max(100),
      description: z.string().trim().max(1000).nullable().default(null),
      targetAgentId: z.uuid(),
      prompt: z.string().min(1).max(20000),
      visibility: z.enum(['private', 'workspace']).default('workspace'),
   })
   .strict();
export type QuickActionCreate = z.infer<typeof quickActionCreateSchema>;

export const quickActionPatchSchema = z
   .object({
      name: z.string().trim().min(1).max(100).optional(),
      description: z.string().trim().max(1000).nullable().optional(),
      targetAgentId: z.uuid().optional(),
      prompt: z.string().min(1).max(20000).optional(),
      visibility: z.enum(['private', 'workspace']).optional(),
   })
   .strict();
export type QuickActionPatch = z.infer<typeof quickActionPatchSchema>;

export interface QuickAction {
   id: string;
   workspaceId: string;
   name: string;
   description: string | null;
   targetAgentId: string;
   prompt: string;
   visibility: 'private' | 'workspace';
   createdBy: string;
   createdAt: string;
   updatedAt: string;
}

export class QuickActionNameTaken extends Error {
   constructor() {
      super('a shared quick action with that name exists');
      this.name = 'QuickActionNameTaken';
   }
}

const COLUMNS =
   'id, workspace_id, name, description, target_agent_id, prompt, visibility, created_by, created_at, updated_at';

function toAction(row: Record<string, unknown>): QuickAction {
   return {
      id: row.id as string,
      workspaceId: row.workspace_id as string,
      name: row.name as string,
      description: (row.description as string | null) ?? null,
      targetAgentId: row.target_agent_id as string,
      prompt: row.prompt as string,
      visibility: row.visibility as 'private' | 'workspace',
      createdBy: row.created_by as string,
      createdAt: toRFC3339(row.created_at as string) ?? '',
      updatedAt: toRFC3339(row.updated_at as string) ?? '',
   };
}

function mapWriteError(error: unknown): never {
   const code = (error as { code?: string }).code;
   if (code === '23505') throw new QuickActionNameTaken();
   if (code === '23503') throw new NotFound();
   throw error;
}

export async function listQuickActions(q: Queryable, workspaceId: string, viewerId: string): Promise<QuickAction[]> {
   const rows = await q`
      SELECT ${q.unsafe(COLUMNS)} FROM quick_action_definitions
       WHERE workspace_id = ${workspaceId} AND archived_at IS NULL
         AND (visibility = 'workspace' OR created_by = ${viewerId})
       ORDER BY lower(name), id`;
   return rows.map(toAction);
}

export async function findVisible(q: Queryable, workspaceId: string, actionId: string, viewerId: string): Promise<QuickAction> {
   const [row] = await q`
      SELECT ${q.unsafe(COLUMNS)} FROM quick_action_definitions
       WHERE id = ${actionId} AND workspace_id = ${workspaceId} AND archived_at IS NULL
         AND (visibility = 'workspace' OR created_by = ${viewerId})`;
   if (!row) throw new NotFound();
   return toAction(row);
}

export async function createQuickAction(
   q: Queryable,
   workspaceId: string,
   actorId: string,
   input: QuickActionCreate
): Promise<QuickAction> {
   const rows = await q`
      INSERT INTO quick_action_definitions
         (workspace_id, name, description, target_agent_id, prompt, visibility, created_by)
      VALUES (${workspaceId}, ${input.name}, ${input.description}, ${input.targetAgentId},
              ${input.prompt}, ${input.visibility}, ${actorId})
      RETURNING ${q.unsafe(COLUMNS)}`.catch(mapWriteError);
   const [row] = rows;
   if (!row) throw new NotFound();
   return toAction(row);
}

export async function updateQuickAction(
   q: Queryable,
   input: { workspaceId: string; actionId: string; actorId: string; moderator: boolean; patch: QuickActionPatch }
): Promise<QuickAction> {
   const current = await findVisible(q, input.workspaceId, input.actionId, input.actorId);
   if (current.createdBy !== input.actorId && !input.moderator) throw new Forbidden();
   const { patch } = input;
   const rows = await q`
      UPDATE quick_action_definitions SET
         name = COALESCE(${patch.name ?? null}, name),
         description = CASE WHEN ${patch.description !== undefined} THEN ${patch.description ?? null}::text ELSE description END,
         target_agent_id = COALESCE(${patch.targetAgentId ?? null}::uuid, target_agent_id),
         prompt = COALESCE(${patch.prompt ?? null}, prompt),
         visibility = COALESCE(${patch.visibility ?? null}, visibility),
         updated_at = now()
       WHERE id = ${input.actionId}
      RETURNING ${q.unsafe(COLUMNS)}`.catch(mapWriteError);
   const [row] = rows;
   if (!row) throw new NotFound();
   return toAction(row);
}

export async function archiveQuickAction(
   q: Queryable,
   input: { workspaceId: string; actionId: string; actorId: string; moderator: boolean }
): Promise<void> {
   const current = await findVisible(q, input.workspaceId, input.actionId, input.actorId);
   if (current.createdBy !== input.actorId && !input.moderator) throw new Forbidden();
   await q`
      UPDATE quick_action_definitions SET archived_at = now(), updated_at = now()
       WHERE id = ${input.actionId}`;
}

export function renderPrompt(
   template: string,
   issue: { identifier: string; title: string; description: string | null }
): string {
   return template.replace(/\{\{\s*issue\.(identifier|title|description)\s*\}\}/g, (_match, field: string) => {
      if (field === 'identifier') return issue.identifier;
      if (field === 'title') return issue.title;
      return issue.description ?? '';
   });
}

export async function runQuickAction(
   sql: Sql,
   enqueue: QuickActionEnqueue,
   input: {
      workspaceId: string;
      actionId: string;
      viewerId: string;
      issue: { id: string; identifier: string; title: string; description: string | null };
   }
): Promise<{ runId: string }> {
   const action = await findVisible(sql, input.workspaceId, input.actionId, input.viewerId);
   return enqueue(sql, {
      workspaceId: input.workspaceId,
      agentId: action.targetAgentId,
      issueId: input.issue.id,
      kind: 'agent',
      source: 'quick_action',
      prompt: renderPrompt(action.prompt, input.issue),
   });
}
