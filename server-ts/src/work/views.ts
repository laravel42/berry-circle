import { z } from 'zod';
import { toRFC3339, type Queryable } from '../db/pool.ts';
import { Forbidden, NotFound } from '../identity/errors.ts';

/** Saved views (`saved_issue_views`) and each person's view preferences. */
const jsonObject = z.record(z.string(), z.unknown());

export const viewCreateSchema = z
   .object({
      workspaceId: z.uuid(),
      name: z.string().trim().min(1).max(80),
      visibility: z.enum(['private', 'workspace']).default('private'),
      query: jsonObject,
      display: jsonObject.default({}),
   })
   .strict();
export type ViewCreate = z.infer<typeof viewCreateSchema>;

export const viewPatchSchema = z
   .object({
      name: z.string().trim().min(1).max(80).optional(),
      visibility: z.enum(['private', 'workspace']).optional(),
      query: jsonObject.optional(),
      display: jsonObject.optional(),
      revision: z.number().int().min(1),
   })
   .strict();
export type ViewPatch = z.infer<typeof viewPatchSchema>;

export const preferencesSchema = z
   .object({
      workspaceId: z.uuid(),
      activeViewId: z.uuid().nullable(),
      preferences: jsonObject,
   })
   .strict();

export interface SavedView {
   id: string;
   workspaceId: string;
   ownerId: string;
   name: string;
   visibility: string;
   definitionVersion: number;
   query: unknown;
   display: unknown;
   revision: number;
   createdAt: string;
   updatedAt: string;
}

export class ViewRevisionConflict extends Error {
   readonly currentRevision: number;
   constructor(currentRevision: number) {
      super('the view changed since it was read');
      this.name = 'ViewRevisionConflict';
      this.currentRevision = currentRevision;
   }
}

const COLUMNS =
   'id, workspace_id, owner_id, name, visibility, definition_version, query, display, revision, created_at, updated_at';

function toView(row: Record<string, unknown>): SavedView {
   return {
      id: row.id as string,
      workspaceId: row.workspace_id as string,
      ownerId: row.owner_id as string,
      name: row.name as string,
      visibility: row.visibility as string,
      definitionVersion: Number(row.definition_version),
      query: row.query,
      display: row.display,
      revision: Number(row.revision),
      createdAt: toRFC3339(row.created_at as string) ?? '',
      updatedAt: toRFC3339(row.updated_at as string) ?? '',
   };
}

export async function viewWorkspace(q: Queryable, viewId: string): Promise<string | null> {
   const [row] = await q`SELECT workspace_id FROM saved_issue_views WHERE id = ${viewId}`;
   return row ? (row.workspace_id as string) : null;
}

export async function createView(
   q: Queryable,
   workspaceId: string,
   ownerId: string,
   input: ViewCreate
): Promise<SavedView> {
   const [row] = await q`
      INSERT INTO saved_issue_views (workspace_id, owner_id, name, visibility, query, display)
      VALUES (${workspaceId}, ${ownerId}, ${input.name}, ${input.visibility},
              ${q.json(input.query as never)}, ${q.json(input.display as never)})
      RETURNING ${q.unsafe(COLUMNS)}`;
   if (!row) throw new NotFound();
   return toView(row);
}

/** Locks the row and applies the visibility and ownership rules. */
async function lockEditable(
   q: Queryable,
   input: { workspaceId: string; viewId: string; actorId: string; moderator: boolean }
): Promise<number> {
   const [row] = await q`
      SELECT owner_id, visibility, revision FROM saved_issue_views
       WHERE id = ${input.viewId} AND workspace_id = ${input.workspaceId} FOR UPDATE`;
   if (!row) throw new NotFound();
   const owns = row.owner_id === input.actorId;
   if (row.visibility === 'private' && !owns) throw new NotFound();
   if (!owns && !input.moderator) throw new Forbidden();
   return Number(row.revision);
}

export async function updateView(
   q: Queryable,
   input: { workspaceId: string; viewId: string; actorId: string; moderator: boolean; patch: ViewPatch }
): Promise<SavedView> {
   const current = await lockEditable(q, input);
   if (current !== input.patch.revision) throw new ViewRevisionConflict(current);
   const { patch } = input;
   const [row] = await q`
      UPDATE saved_issue_views SET
         name = COALESCE(${patch.name ?? null}, name),
         visibility = COALESCE(${patch.visibility ?? null}, visibility),
         query = COALESCE(${patch.query ? q.json(patch.query as never) : null}::jsonb, query),
         display = COALESCE(${patch.display ? q.json(patch.display as never) : null}::jsonb, display),
         revision = revision + 1
       WHERE id = ${input.viewId}
      RETURNING ${q.unsafe(COLUMNS)}`;
   if (!row) throw new NotFound();
   return toView(row);
}

export async function deleteView(
   q: Queryable,
   input: { workspaceId: string; viewId: string; actorId: string; moderator: boolean }
): Promise<void> {
   await lockEditable(q, input);
   await q`DELETE FROM saved_issue_views WHERE id = ${input.viewId}`;
}

export async function readPreferences(
   q: Queryable,
   workspaceId: string,
   userId: string
): Promise<{ activeViewId: string | null; preferences: Record<string, unknown> }> {
   const [row] = await q`
      SELECT active_view_id, preferences FROM issue_view_preferences
       WHERE workspace_id = ${workspaceId} AND user_id = ${userId}`;
   return {
      activeViewId: (row?.active_view_id as string | null | undefined) ?? null,
      preferences: (row?.preferences as Record<string, unknown> | undefined) ?? {},
   };
}

export async function writePreferences(
   q: Queryable,
   workspaceId: string,
   userId: string,
   input: { activeViewId: string | null; preferences: Record<string, unknown> }
): Promise<{ activeViewId: string | null; preferences: Record<string, unknown> }> {
   if (input.activeViewId !== null) {
      const [visible] = await q`
         SELECT 1 FROM saved_issue_views
          WHERE id = ${input.activeViewId} AND workspace_id = ${workspaceId}
            AND (visibility <> 'private' OR owner_id = ${userId})`;
      if (!visible) throw new NotFound();
   }
   await q`
      INSERT INTO issue_view_preferences (workspace_id, user_id, active_view_id, preferences)
      VALUES (${workspaceId}, ${userId}, ${input.activeViewId}, ${q.json(input.preferences as never)})
      ON CONFLICT (workspace_id, user_id)
      DO UPDATE SET active_view_id = EXCLUDED.active_view_id, preferences = EXCLUDED.preferences`;
   return readPreferences(q, workspaceId, userId);
}
