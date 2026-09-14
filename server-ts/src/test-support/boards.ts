import { randomUUID } from 'node:crypto';
import type { Sql } from '../db/pool.ts';

/**
 * Inserts a board the way the product allows: its creator must hold an active
 * membership in the board's workspace (berry_boards_assign_workspace raises
 * "board creator has no active workspace membership", 23503, otherwise).
 * Fixtures used to insert the board first, or name a user from another
 * workspace; this makes the creator a member first — as `role`, and only when
 * they are not one already, so an existing role is never changed. Test
 * support only; not a test file.
 */
export async function insertBoard(
   sql: Sql,
   board: {
      workspaceId: string;
      createdBy: string;
      name: string;
      slug: string;
      id?: string;
      role?: 'owner' | 'admin' | 'member' | 'viewer';
   }
): Promise<string> {
   await sql`
      INSERT INTO workspace_memberships (workspace_id, user_id, role)
      VALUES (${board.workspaceId}, ${board.createdBy}, ${board.role ?? 'owner'})
      ON CONFLICT (workspace_id, user_id) DO NOTHING`;
   const [row] = await sql`
      INSERT INTO boards (id, workspace_id, name, slug, created_by)
      VALUES (${board.id ?? randomUUID()}, ${board.workspaceId}, ${board.name}, ${board.slug}, ${board.createdBy})
      RETURNING id`;
   return row!.id as string;
}

/**
 * Deletes every board in the given workspaces, the default board a workspace is
 * given by trigger (migration 183) included. Test teardown only; not a test
 * file.
 *
 * `boards.workspace_id` is RESTRICT, so a workspace cannot be deleted while a
 * board of its own remains — and since 183 every workspace has one whether its
 * fixture asked for one or not. Issues are left to the caller: a fixture that
 * filed them knows where they are, and the default board never holds any.
 */
export async function deleteWorkspaceBoards(sql: Sql, workspaceIds: readonly string[]): Promise<void> {
   const ids = workspaceIds.filter((id): id is string => Boolean(id));
   if (ids.length === 0) return;
   await sql`DELETE FROM boards WHERE workspace_id IN ${sql(ids)}`;
}
