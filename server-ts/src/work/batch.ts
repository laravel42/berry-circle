import { z } from 'zod';
import type { Queryable } from '../db/pool.ts';
import { NotFound } from '../identity/errors.ts';

/** Request shapes and small queries for the batch, move and create routes. */
const API_STATUSES = ['backlog', 'todo', 'inProgress', 'inReview', 'done', 'blocked', 'cancelled'] as const;
const PRIORITIES = ['none', 'urgent', 'high', 'medium', 'low'] as const;
const assignee = z.object({ type: z.enum(['user', 'agent']), id: z.uuid() }).strict();
const issueIds = z.array(z.uuid()).min(1).max(100);

export const batchUpdateSchema = z
   .object({
      issueIds,
      patch: z
         .object({
            status: z.enum(API_STATUSES).optional(),
            statusId: z.uuid().optional(),
            priority: z.enum(PRIORITIES).optional(),
            assignee: assignee.nullable().optional(),
         })
         .strict()
         .refine((patch) => Object.keys(patch).length > 0, { message: 'At least one field must be provided.' })
         .refine((patch) => !(patch.status && patch.statusId), { message: 'Send status or statusId, not both.' }),
   })
   .strict();
export type BatchUpdate = z.infer<typeof batchUpdateSchema>;

export const batchDeleteSchema = z.object({ issueIds }).strict();

export const moveSchema = z
   .object({ beforeId: z.uuid().nullable().optional(), afterId: z.uuid().nullable().optional() })
   .strict();

export const quickCreateSchema = z
   .object({
      workspaceId: z.uuid(),
      title: z.string().trim().min(1).max(500),
      boardId: z.uuid().optional(),
      parentId: z.uuid().optional(),
      stage: z.number().int().min(0).max(1000).optional(),
   })
   .strict();

export const childCreateSchema = z
   .object({
      title: z.string().trim().min(1).max(500).optional(),
      fromCommentId: z.uuid().optional(),
      stage: z.number().int().min(0).max(1000).nullable().optional(),
   })
   .strict()
   .refine((value) => value.title !== undefined || value.fromCommentId !== undefined, {
      message: 'Provide a title or a comment to create from.',
   });

export const parentSchema = z
   .object({ parentId: z.uuid().nullable(), stage: z.number().int().min(0).max(1000).nullable().optional() })
   .strict();

export const statusChangeSchema = z.object({ statusId: z.uuid() }).strict();

export const subscriptionSchema = z.object({ subtree: z.boolean().default(false) }).strict();

const GAP = 1000;

/** Same arithmetic as the board's drag and drop (`frontend/lib/issues.ts`). */
export function sortOrderBetween(before?: number, after?: number): number {
   if (before === undefined && after === undefined) return GAP;
   if (before === undefined) return Math.max(0, (after ?? 0) - GAP);
   if (after === undefined) return before + GAP;
   const middle = Math.floor((before + after) / 2);
   if (middle <= before || middle >= after) return before + GAP;
   return middle;
}

export async function sortOrderOf(q: Queryable, issueId: string): Promise<number> {
   const [row] = await q`SELECT sort_order FROM issues WHERE id = ${issueId} AND deleted_at IS NULL`;
   if (!row) throw new NotFound();
   return Number(row.sort_order);
}

export async function defaultBoardId(q: Queryable, workspaceId: string): Promise<string> {
   const [row] = await q`
      SELECT id FROM boards WHERE workspace_id = ${workspaceId}
       ORDER BY created_at ASC, id ASC LIMIT 1`;
   if (!row) throw new NotFound();
   return row.id as string;
}

/** Who this person assigns work to most, over the last 90 days. */
export async function assigneeFrequency(
   q: Queryable,
   workspaceId: string,
   userId: string
): Promise<Array<{ type: string; id: string; count: number }>> {
   const rows = await q`
      SELECT assignment.assignee_type::text AS type, assignment.assignee_id AS id, count(*)::int AS count
        FROM assignments AS assignment
        JOIN issues AS issue ON issue.id = assignment.issue_id
        JOIN boards AS board ON board.id = issue.board_id
       WHERE board.workspace_id = ${workspaceId} AND assignment.assigned_by = ${userId}
         AND assignment.created_at > now() - interval '90 days'
       GROUP BY 1, 2
       ORDER BY count DESC, type ASC, id ASC
       LIMIT 10`;
   return rows.map((row) => ({ type: row.type as string, id: row.id as string, count: Number(row.count) }));
}
