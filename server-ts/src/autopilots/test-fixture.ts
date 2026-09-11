import { randomBytes, randomUUID } from 'node:crypto';
import type { Sql } from '../db/pool.ts';
import { sealerFromKey, type Sealer } from '../integrations/sealing.ts';
import { deleteWorkspaceAgents } from '../test-support/protected-agents.ts';

/**
 * One workspace with an owner, a board and an agent — what every autopilot
 * test needs before it can create one. Shared so the five DB-backed files
 * seed and tidy the same way, including the protected Orchestrator the
 * workspace-insert trigger provisions (see server-ts/ROUTING.md).
 */

export interface Fixture {
   userId: string;
   workspaceId: string;
   boardId: string;
   agentId: string;
}

export function testSealer(): Sealer {
   return sealerFromKey(randomBytes(32).toString('base64'));
}

export async function seedWorkspace(sql: Sql, label: string): Promise<Fixture> {
   const suffix = randomUUID().slice(0, 8);
   const [user] = await sql`
      INSERT INTO users (id, email, name)
      VALUES (${randomUUID()}, ${`${label}-${suffix}@berry.test`}, ${`Autopilot ${label}`})
      RETURNING id`;
   if (!user) throw new Error('user insert returned no row');
   const userId = user.id as string;

   const [workspace] = await sql`
      INSERT INTO workspaces (id, name, slug, settings, created_by)
      VALUES (${randomUUID()}, ${`Autopilot ${label} ${suffix}`}, ${`ap-${label}-${suffix}`},
              ${sql.json({ issuePrefix: 'APX', defaultRole: 'member', allowMemberInvites: false } as never)},
              ${userId})
      RETURNING id`;
   if (!workspace) throw new Error('workspace insert returned no row');
   const workspaceId = workspace.id as string;

   await sql`
      INSERT INTO workspace_memberships (workspace_id, user_id, role)
      VALUES (${workspaceId}, ${userId}, 'owner')`;

   const [board] = await sql`
      INSERT INTO boards (id, workspace_id, name, slug, created_by)
      VALUES (${randomUUID()}, ${workspaceId}, 'Autopilot board', ${`ap-${suffix}`}, ${userId})
      RETURNING id`;
   if (!board) throw new Error('board insert returned no row');

   const [agent] = await sql`
      INSERT INTO agents (id, workspace_id, board_id, name, instructions)
      VALUES (${randomUUID()}, ${workspaceId}, ${board.id as string}, 'Pilot', 'Be brief.')
      RETURNING id`;
   if (!agent) throw new Error('agent insert returned no row');

   return { userId, workspaceId, boardId: board.id as string, agentId: agent.id as string };
}

export async function cleanupWorkspace(sql: Sql, fixture: Fixture): Promise<void> {
   await sql`DELETE FROM outbox_events WHERE workspace_id = ${fixture.workspaceId}`;
   await sql`DELETE FROM autopilots WHERE workspace_id = ${fixture.workspaceId}`;
   await sql`
      DELETE FROM issues
       WHERE board_id IN (SELECT id FROM boards WHERE workspace_id = ${fixture.workspaceId})`;
   await deleteWorkspaceAgents(sql, [fixture.workspaceId]);
   await sql`DELETE FROM boards WHERE workspace_id = ${fixture.workspaceId}`;
   await sql`DELETE FROM workspace_memberships WHERE workspace_id = ${fixture.workspaceId}`;
   await sql`DELETE FROM workspaces WHERE id = ${fixture.workspaceId}`;
   await sql`DELETE FROM users WHERE id = ${fixture.userId}`;
}
