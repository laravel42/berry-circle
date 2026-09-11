import { randomUUID } from 'node:crypto';
import type { Sql } from '../db/pool.ts';
import { deleteWorkspaceAgents } from '../test-support/protected-agents.ts';

/**
 * One workspace, board, agent and owner for the runtime DB tests.
 *
 * Mirrors the ledger suite's fixture (`runs/ledger.test.ts`), including the
 * teardown that briefly suspends the protected-agent guard: creating a
 * workspace provisions a protected Orchestrator by trigger, and without the
 * suspension every run of the suite would leak a workspace.
 */
export interface Fixture {
   workspaceId: string;
   boardId: string;
   agentId: string;
   userId: string;
   /** The workspace's protected Orchestrator, provisioned by trigger. */
   orchestratorId: string;
}

export async function seedFixture(sql: Sql, label: string): Promise<Fixture> {
   const suffix = randomUUID().slice(0, 8);
   const [user] = await sql`
      INSERT INTO users (id, email, name)
      VALUES (${randomUUID()}, ${`${label}-${suffix}@berry.test`}, ${`${label} test`})
      RETURNING id`;
   const userId = user!.id as string;
   const [workspace] = await sql`
      INSERT INTO workspaces (id, name, slug, settings, created_by)
      VALUES (${randomUUID()}, ${`${label} ${suffix}`}, ${`${label}-${suffix}`},
              ${sql.json({ issuePrefix: 'RTM', defaultRole: 'member', allowMemberInvites: false } as never)},
              ${userId})
      RETURNING id`;
   const workspaceId = workspace!.id as string;
   await sql`
      INSERT INTO workspace_memberships (workspace_id, user_id, role)
      VALUES (${workspaceId}, ${userId}, 'owner')`;
   const [board] = await sql`
      INSERT INTO boards (id, workspace_id, name, slug, created_by)
      VALUES (${randomUUID()}, ${workspaceId}, 'Runtime board', ${`rtm-${suffix}`}, ${userId})
      RETURNING id`;
   const boardId = board!.id as string;
   const [agent] = await sql`
      INSERT INTO agents (id, workspace_id, board_id, name, instructions)
      VALUES (${randomUUID()}, ${workspaceId}, ${boardId}, 'Runtime Agent', 'Be brief.')
      RETURNING id`;
   const [orchestrator] = await sql`
      SELECT id FROM agents WHERE workspace_id = ${workspaceId} AND protected`;
   return {
      workspaceId,
      boardId,
      agentId: agent!.id as string,
      userId,
      orchestratorId: orchestrator!.id as string,
   };
}

export async function createIssue(sql: Sql, fixture: Fixture, title = 'Runtime task'): Promise<string> {
   const issueId = randomUUID();
   await sql.begin(async (tx) => {
      const [counter] = await tx`
         UPDATE boards SET issue_counter = issue_counter + 1
          WHERE id = ${fixture.boardId} RETURNING issue_counter`;
      await tx`
         INSERT INTO issues (id, board_id, number, title, status, created_by)
         VALUES (${issueId}, ${fixture.boardId}, ${Number(counter!.issue_counter)},
                 ${title}, 'todo', ${fixture.userId})`;
   });
   return issueId;
}

export async function cleanupFixture(sql: Sql, fixture: Fixture | null): Promise<void> {
   if (!fixture) return;
   await sql`DELETE FROM outbox_events WHERE workspace_id = ${fixture.workspaceId}`;
   await sql`DELETE FROM runs WHERE workspace_id = ${fixture.workspaceId}`;
   await sql`DELETE FROM issues WHERE board_id = ${fixture.boardId}`;
   await deleteWorkspaceAgents(sql, [fixture.workspaceId]);
   await sql`DELETE FROM agent_runtimes WHERE workspace_id = ${fixture.workspaceId}`;
   await sql`DELETE FROM boards WHERE workspace_id = ${fixture.workspaceId}`;
   await sql`DELETE FROM workspace_memberships WHERE workspace_id = ${fixture.workspaceId}`;
   await sql`DELETE FROM workspaces WHERE id = ${fixture.workspaceId}`;
   await sql`DELETE FROM users WHERE id = ${fixture.userId}`;
}
