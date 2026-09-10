import { z } from 'zod';
import type { Queryable } from '../db/pool.ts';
import { NotFound } from '../identity/errors.ts';

/** A person's sidebar pins in one workspace (`user_pins`). */
export const PIN_TARGETS = ['issue', 'view', 'project'] as const;
export type PinTarget = (typeof PIN_TARGETS)[number];

export const pinCreateSchema = z
   .object({ workspaceId: z.uuid(), targetType: z.enum(PIN_TARGETS), targetId: z.uuid() })
   .strict();
export const pinOrderSchema = z
   .object({ workspaceId: z.uuid(), ids: z.array(z.uuid()).min(1).max(200) })
   .strict();

export interface Pin {
   id: string;
   targetType: PinTarget;
   targetId: string;
   position: number;
   title: string;
   identifier: string | null;
}

/** Pins whose target is gone or no longer visible are left out, not shown blank. */
export async function listPins(q: Queryable, workspaceId: string, userId: string): Promise<Pin[]> {
   const rows = await q`
      SELECT pin.id, pin.target_type, pin.target_id, pin.position,
             COALESCE(issue.title, saved.name, project.name) AS title,
             CASE WHEN pin.target_type = 'issue'
                  THEN berry_issue_identifier(${workspaceId}, issue.number) END AS identifier
        FROM user_pins AS pin
        LEFT JOIN issues AS issue
          ON pin.target_type = 'issue' AND issue.id = pin.target_id AND issue.deleted_at IS NULL
        LEFT JOIN saved_issue_views AS saved
          ON pin.target_type = 'view' AND saved.id = pin.target_id
         AND (saved.visibility <> 'private' OR saved.owner_id = ${userId})
        LEFT JOIN projects AS project
          ON pin.target_type = 'project' AND project.id = pin.target_id AND project.deleted_at IS NULL
       WHERE pin.workspace_id = ${workspaceId} AND pin.user_id = ${userId}
       ORDER BY pin.position, pin.id`;
   return rows
      .filter((row) => row.title !== null)
      .map((row) => ({
         id: row.id as string,
         targetType: row.target_type as PinTarget,
         targetId: row.target_id as string,
         position: Number(row.position),
         title: row.title as string,
         identifier: (row.identifier as string | null) ?? null,
      }));
}

async function targetVisible(
   q: Queryable,
   workspaceId: string,
   userId: string,
   targetType: PinTarget,
   targetId: string
): Promise<boolean> {
   const rows =
      targetType === 'issue'
         ? await q`
              SELECT 1 FROM issues AS issue JOIN boards AS board ON board.id = issue.board_id
               WHERE issue.id = ${targetId} AND board.workspace_id = ${workspaceId}
                 AND issue.deleted_at IS NULL`
         : targetType === 'view'
           ? await q`
                SELECT 1 FROM saved_issue_views
                 WHERE id = ${targetId} AND workspace_id = ${workspaceId}
                   AND (visibility <> 'private' OR owner_id = ${userId})`
           : await q`
                SELECT 1 FROM projects
                 WHERE id = ${targetId} AND workspace_id = ${workspaceId} AND deleted_at IS NULL`;
   return rows.length === 1;
}

export async function pin(
   q: Queryable,
   workspaceId: string,
   userId: string,
   targetType: PinTarget,
   targetId: string
): Promise<Pin> {
   if (!(await targetVisible(q, workspaceId, userId, targetType, targetId))) throw new NotFound();
   await q`
      INSERT INTO user_pins (workspace_id, user_id, target_type, target_id, position)
      VALUES (${workspaceId}, ${userId}, ${targetType}, ${targetId},
              COALESCE((SELECT max(position) + 1 FROM user_pins
                         WHERE workspace_id = ${workspaceId} AND user_id = ${userId}), 0))
      ON CONFLICT (workspace_id, user_id, target_type, target_id) DO NOTHING`;
   const found = (await listPins(q, workspaceId, userId)).find(
      (entry) => entry.targetType === targetType && entry.targetId === targetId
   );
   if (!found) throw new NotFound();
   return found;
}

export async function unpin(q: Queryable, workspaceId: string, userId: string, pinId: string): Promise<boolean> {
   const rows = await q`
      DELETE FROM user_pins WHERE id = ${pinId} AND workspace_id = ${workspaceId} AND user_id = ${userId}
      RETURNING id`;
   return rows.length === 1;
}

/** Positions are unique but deferrable, so the swap commits as one statement. */
export async function reorderPins(
   q: Queryable,
   workspaceId: string,
   userId: string,
   ids: string[]
): Promise<Pin[]> {
   await q`
      UPDATE user_pins AS pin SET position = ordered.position - 1
        FROM unnest(${ids}::uuid[]) WITH ORDINALITY AS ordered(id, position)
       WHERE pin.id = ordered.id AND pin.workspace_id = ${workspaceId} AND pin.user_id = ${userId}`;
   return listPins(q, workspaceId, userId);
}
