import { randomUUID } from 'node:crypto';
import type { Sql } from '../db/pool.ts';

/**
 * A populated workspace for the work-tracking tests.
 *
 * Not a test file (no `.test.ts`), so the runner never executes it; tests
 * import it. `cleanupWorld` removes what `seedWorld` made in dependency order,
 * including the protected orchestrator the workspace trigger provisions.
 */
export interface World {
   workspaceId: string;
   boardId: string;
   ownerId: string;
   memberId: string;
   viewerId: string;
   agentId: string;
   issueId: string;
}

export interface IssueFields {
   title?: string;
   status?: string;
   parentId?: string | null;
   stage?: number | null;
   agentAssignee?: boolean;
}

function first(rows: ReadonlyArray<Record<string, unknown>>, what: string): Record<string, unknown> {
   const row = rows[0];
   if (!row) throw new Error(`${what} insert returned no row`);
   return row;
}

async function createUser(sql: Sql, handle: string, name: string): Promise<string> {
   const rows = await sql`
      INSERT INTO users (id, email, name)
      VALUES (${randomUUID()}, ${`${handle}@berry.test`}, ${name})
      RETURNING id`;
   return first(rows, 'user').id as string;
}

export async function seedWorld(sql: Sql, tag: string): Promise<World> {
   const suffix = `${tag}-${randomUUID().slice(0, 8)}`;
   const ownerId = await createUser(sql, `owner-${suffix}`, 'Owner');
   const memberId = await createUser(sql, `member-${suffix}`, 'Member');
   const viewerId = await createUser(sql, `viewer-${suffix}`, 'Viewer');

   const workspace = first(
      await sql`
         INSERT INTO workspaces (id, name, slug, settings, created_by)
         VALUES (${randomUUID()}, ${`Work ${suffix}`}, ${`work-${suffix}`},
                 ${sql.json({ issuePrefix: 'WRK', defaultRole: 'member', allowMemberInvites: false } as never)},
                 ${ownerId})
         RETURNING id`,
      'workspace'
   );
   const workspaceId = workspace.id as string;
   for (const [userId, role] of [
      [ownerId, 'owner'],
      [memberId, 'member'],
      [viewerId, 'viewer'],
   ] as const) {
      await sql`
         INSERT INTO workspace_memberships (workspace_id, user_id, role)
         VALUES (${workspaceId}, ${userId}, ${role})`;
   }

   const board = first(
      await sql`
         INSERT INTO boards (id, workspace_id, name, slug, created_by)
         VALUES (${randomUUID()}, ${workspaceId}, 'Work', ${`w${randomUUID().slice(0, 8)}`}, ${ownerId})
         RETURNING id`,
      'board'
   );
   const boardId = board.id as string;

   const agent = first(
      await sql`
         INSERT INTO agents (id, workspace_id, board_id, name, status)
         VALUES (${randomUUID()}, ${workspaceId}, ${boardId}, 'Worker', 'available')
         RETURNING id`,
      'agent'
   );

   const world: World = {
      workspaceId,
      boardId,
      ownerId,
      memberId,
      viewerId,
      agentId: agent.id as string,
      issueId: '',
   };
   world.issueId = await createIssue(sql, world, { title: 'Root task' });
   return world;
}

export async function createIssue(sql: Sql, world: World, fields: IssueFields = {}): Promise<string> {
   const id = randomUUID();
   const counter = first(
      await sql`
         UPDATE boards SET issue_counter = issue_counter + 1 WHERE id = ${world.boardId}
         RETURNING issue_counter`,
      'counter'
   );
   await sql`
      INSERT INTO issues (id, board_id, number, title, status, parent_id, stage,
                          assignee_type, assignee_id, created_by)
      VALUES (${id}, ${world.boardId}, ${Number(counter.issue_counter)}, ${fields.title ?? 'Task'},
              ${fields.status ?? 'backlog'}::issue_status, ${fields.parentId ?? null},
              ${fields.stage ?? null},
              ${fields.agentAssignee ? 'agent' : null}::assignee_type,
              ${fields.agentAssignee ? world.agentId : null}, ${world.ownerId})`;
   return id;
}

export async function cleanupWorld(sql: Sql, world: World | undefined): Promise<void> {
   if (!world?.workspaceId) return;
   await sql`DELETE FROM inbox_items WHERE workspace_id = ${world.workspaceId}`;
   await sql`DELETE FROM outbox_events WHERE workspace_id = ${world.workspaceId}`;
   await sql`DELETE FROM quick_action_definitions WHERE workspace_id = ${world.workspaceId}`;
   await sql`DELETE FROM issues WHERE board_id = ${world.boardId}`;
   // Replica mode skips the protected-agent trigger for this transaction only.
   // ALTER TABLE ... DISABLE TRIGGER would take an exclusive lock on agents,
   // which stalls test files running in parallel against the same database.
   await sql.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`DELETE FROM agents WHERE workspace_id = ${world.workspaceId}`;
   });
   await sql`DELETE FROM boards WHERE workspace_id = ${world.workspaceId}`;
   await sql`DELETE FROM workspace_memberships WHERE workspace_id = ${world.workspaceId}`;
   await sql`DELETE FROM workspaces WHERE id = ${world.workspaceId}`;
   for (const id of [world.ownerId, world.memberId, world.viewerId]) {
      await sql`DELETE FROM users WHERE id = ${id}`;
   }
}
