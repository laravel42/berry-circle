import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Queryable } from '../db/pool.ts';
import { NotFound } from '../identity/errors.ts';

/**
 * Workspace statuses. Each belongs to one fixed category, and the category is
 * what `issues.status` stores, so the board, the run ledger and the review gate
 * keep working on categories while people see their own names.
 */
export const STATUS_CATEGORIES = [
   'backlog',
   'todo',
   'in_progress',
   'in_review',
   'done',
   'blocked',
   'cancelled',
] as const;

export const statusCreateSchema = z
   .object({
      name: z.string().trim().min(1).max(100),
      category: z.enum(STATUS_CATEGORIES),
      color: z.string().regex(/^#[0-9a-f]{6}$/),
      description: z.string().trim().max(1000).nullable().default(null),
   })
   .strict();
export type StatusCreate = z.infer<typeof statusCreateSchema>;

export const statusOrderSchema = z.object({ ids: z.array(z.uuid()).min(1).max(200) }).strict();

export interface StatusDefinition {
   id: string;
   key: string;
   name: string;
   description: string | null;
   category: string;
   color: string;
   sortOrder: number;
   isSystem: boolean;
}

export class StatusNameTaken extends Error {
   constructor() {
      super('a status with that name exists');
      this.name = 'StatusNameTaken';
   }
}

export class SystemStatusProtected extends Error {
   constructor() {
      super('a system status cannot be archived');
      this.name = 'SystemStatusProtected';
   }
}

export class StatusOrderMismatch extends Error {
   constructor() {
      super('the order must name every active status exactly once');
      this.name = 'StatusOrderMismatch';
   }
}

const COLUMNS = 'id, key, name, description, category, color, sort_order, is_system';

function toStatus(row: Record<string, unknown>): StatusDefinition {
   return {
      id: row.id as string,
      key: row.key as string,
      name: row.name as string,
      description: (row.description as string | null) ?? null,
      category: row.category as string,
      color: row.color as string,
      sortOrder: Number(row.sort_order),
      isSystem: Boolean(row.is_system),
   };
}

export function serializeStatus(status: StatusDefinition): Record<string, unknown> {
   return { ...status };
}

export async function listStatuses(q: Queryable, workspaceId: string): Promise<StatusDefinition[]> {
   const rows = await q`
      SELECT ${q.unsafe(COLUMNS)} FROM issue_status_definitions
       WHERE workspace_id = ${workspaceId} AND archived_at IS NULL
       ORDER BY sort_order ASC, key ASC`;
   return rows.map(toStatus);
}

export async function createStatus(
   q: Queryable,
   workspaceId: string,
   actorId: string,
   input: StatusCreate
): Promise<StatusDefinition> {
   // An opaque key: the category, not the key, is what anything addresses.
   const key = `c${randomBytes(6).toString('hex')}`;
   const rows = await q`
      INSERT INTO issue_status_definitions
         (workspace_id, key, name, description, category, color, sort_order, is_system, created_by)
      VALUES (${workspaceId}, ${key}, ${input.name}, ${input.description}, ${input.category},
              ${input.color},
              COALESCE((SELECT max(sort_order) FROM issue_status_definitions
                         WHERE workspace_id = ${workspaceId} AND category = ${input.category}
                           AND archived_at IS NULL), 0) + 10,
              false, ${actorId})
      RETURNING ${q.unsafe(COLUMNS)}`.catch((error: unknown) => {
      if ((error as { code?: string }).code === '23505') throw new StatusNameTaken();
      throw error;
   });
   const [row] = rows;
   if (!row) throw new NotFound();
   return toStatus(row);
}

export async function archiveStatus(q: Queryable, workspaceId: string, statusId: string): Promise<void> {
   const [row] = await q`
      SELECT is_system FROM issue_status_definitions
       WHERE id = ${statusId} AND workspace_id = ${workspaceId} AND archived_at IS NULL`;
   if (!row) throw new NotFound();
   if (row.is_system === true) throw new SystemStatusProtected();
   await q`UPDATE issues SET status_id = NULL WHERE status_id = ${statusId}`;
   await q`
      UPDATE issue_status_definitions SET archived_at = now(), updated_at = now()
       WHERE id = ${statusId}`;
}

export async function reorderStatuses(
   q: Queryable,
   workspaceId: string,
   ids: string[]
): Promise<StatusDefinition[]> {
   const active = await listStatuses(q, workspaceId);
   const wanted = new Set(ids.map((id) => id.toLowerCase()));
   if (wanted.size !== ids.length || wanted.size !== active.length || active.some((status) => !wanted.has(status.id))) {
      throw new StatusOrderMismatch();
   }
   await q`
      UPDATE issue_status_definitions AS definition
         SET sort_order = ordered.position * 1000, updated_at = now()
        FROM unnest(${ids}::uuid[]) WITH ORDINALITY AS ordered(id, position)
       WHERE definition.id = ordered.id AND definition.workspace_id = ${workspaceId}`;
   return listStatuses(q, workspaceId);
}

export async function resolveStatus(
   q: Queryable,
   workspaceId: string,
   statusId: string
): Promise<StatusDefinition> {
   const [row] = await q`
      SELECT ${q.unsafe(COLUMNS)} FROM issue_status_definitions
       WHERE id = ${statusId} AND workspace_id = ${workspaceId} AND archived_at IS NULL`;
   if (!row) throw new NotFound();
   return toStatus(row);
}
