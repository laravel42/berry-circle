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
      requestedBy?: string;
   }
) => Promise<{ runId: string }>;

/**
 * The template variables Berry can actually fill, from `renderPrompt`.
 *
 * Anything else written as `{{…}}` is refused rather than accepted, because
 * the alternative is silent: an unfilled variable is not an error at run time,
 * it is two braces and a word handed to an agent as if they were instructions.
 * Refusing at the moment it is typed is the only point at which the author is
 * still there to fix it.
 */
const FILLABLE = new Set(['issue.identifier', 'issue.title', 'issue.description']);
const VARIABLE = /\{\{\s*([^}]*?)\s*\}\}/g;

/** The variables in a prompt that Berry has no value for, in order. */
export function unfillableVariables(prompt: string): string[] {
   const unknown: string[] = [];
   for (const match of prompt.matchAll(VARIABLE)) {
      const name = match[1] ?? '';
      if (!FILLABLE.has(name) && !unknown.includes(name)) unknown.push(name);
   }
   return unknown;
}

const promptField = z
   .string()
   .min(1)
   .max(20000)
   .refine((prompt) => unfillableVariables(prompt).length === 0, {
      message: 'prompt uses a variable Berry cannot fill.',
   });

export const quickActionCreateSchema = z
   .object({
      name: z.string().trim().min(1).max(100),
      description: z.string().trim().max(1000).nullable().default(null),
      targetAgentId: z.uuid(),
      prompt: promptField,
      visibility: z.enum(['private', 'workspace']).default('workspace'),
   })
   .strict();
export type QuickActionCreate = z.infer<typeof quickActionCreateSchema>;

export const quickActionPatchSchema = z
   .object({
      name: z.string().trim().min(1).max(100).optional(),
      description: z.string().trim().max(1000).nullable().optional(),
      targetAgentId: z.uuid().optional(),
      prompt: promptField.optional(),
      visibility: z.enum(['private', 'workspace']).optional(),
      /** `false` restores an archived action; `true` is the archive route's job. */
      archived: z.literal(false).optional(),
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
   /** How many times it has been run. Never decremented. */
   useCount: number;
   /** When it was last run, or null if it never has been. */
   lastUsedAt: string | null;
   /** Set while the action is archived; null while it is in use. */
   archivedAt: string | null;
}

export class QuickActionNotArchived extends Error {
   constructor() {
      super('archive a quick action before deleting it');
      this.name = 'QuickActionNotArchived';
   }
}

export class QuickActionNameTaken extends Error {
   constructor() {
      super('a shared quick action with that name exists');
      this.name = 'QuickActionNameTaken';
   }
}

const COLUMNS =
   'id, workspace_id, name, description, target_agent_id, prompt, visibility, created_by, created_at, updated_at, use_count, last_used_at, archived_at';

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
      useCount: Number(row.use_count ?? 0),
      lastUsedAt: toRFC3339(row.last_used_at as string | null),
      archivedAt: toRFC3339(row.archived_at as string | null),
   };
}

function mapWriteError(error: unknown): never {
   const code = (error as { code?: string }).code;
   if (code === '23505') throw new QuickActionNameTaken();
   if (code === '23503') throw new NotFound();
   throw error;
}

/**
 * The quick actions this person can see, most used first.
 *
 * Alphabetical order said nothing about a list a workspace accumulates: the
 * two or three actions anyone runs sat wherever their names happened to put
 * them. Name breaks the tie, so a workspace where nothing has been run yet
 * still reads in a stable, predictable order.
 */
export async function listQuickActions(
   q: Queryable,
   workspaceId: string,
   viewerId: string,
   includeArchived = false
): Promise<QuickAction[]> {
   const rows = await q`
      SELECT ${q.unsafe(COLUMNS)} FROM quick_action_definitions
       WHERE workspace_id = ${workspaceId}
         AND (${includeArchived}::boolean OR archived_at IS NULL)
         AND (visibility = 'workspace' OR created_by = ${viewerId})
       ORDER BY use_count DESC, lower(name), id`;
   return rows.map(toAction);
}

export async function findVisible(
   q: Queryable,
   workspaceId: string,
   actionId: string,
   viewerId: string,
   includeArchived = false
): Promise<QuickAction> {
   const [row] = await q`
      SELECT ${q.unsafe(COLUMNS)} FROM quick_action_definitions
       WHERE id = ${actionId} AND workspace_id = ${workspaceId}
         AND (${includeArchived}::boolean OR archived_at IS NULL)
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
   const { patch } = input;
   // An archived action has to be findable to be restored, so the lookup is
   // widened exactly when the patch is the one that brings it back.
   const restoring = patch.archived === false;
   const current = await findVisible(q, input.workspaceId, input.actionId, input.actorId, restoring);
   if (current.createdBy !== input.actorId && !input.moderator) throw new Forbidden();
   const rows = await q`
      UPDATE quick_action_definitions SET
         archived_at = CASE WHEN ${restoring} THEN NULL ELSE archived_at END,
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

/**
 * Remove an action for good.
 *
 * Separate from archiving, and only reachable for one that is already
 * archived: a list that offers "delete" beside "archive" gets the irreversible
 * one clicked by mistake. Nothing references a definition — a run carries the
 * rendered prompt, not a pointer back — so the row can simply go.
 */
export async function deleteQuickAction(
   q: Queryable,
   input: { workspaceId: string; actionId: string; actorId: string; moderator: boolean }
): Promise<void> {
   const current = await findVisible(q, input.workspaceId, input.actionId, input.actorId, true);
   if (current.createdBy !== input.actorId && !input.moderator) throw new Forbidden();
   if (current.archivedAt === null) throw new QuickActionNotArchived();
   await q`DELETE FROM quick_action_definitions WHERE id = ${input.actionId}`;
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
   // Counted at the point the action is reached for, before the run is
   // enqueued: a run that the queue later refuses was still a use, and the
   // number this feeds — "which of these does anyone touch" — would be wrong
   // if it silently only counted the ones that succeeded.
   await sql`
      UPDATE quick_action_definitions
         SET use_count = use_count + 1, last_used_at = now()
       WHERE id = ${action.id} AND workspace_id = ${input.workspaceId}`;
   return enqueue(sql, {
      workspaceId: input.workspaceId,
      agentId: action.targetAgentId,
      issueId: input.issue.id,
      kind: 'agent',
      source: 'quick_action',
      prompt: renderPrompt(action.prompt, input.issue),
      requestedBy: input.viewerId,
   });
}
