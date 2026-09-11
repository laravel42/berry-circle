import { randomUUID } from 'node:crypto';
import type { Sql } from '../db/pool.ts';
import type { ScopedQuery } from '../identity/workspace-context.ts';
import { deleteWorkspaceAgents } from '../test-support/protected-agents.ts';

/**
 * A workspace with one member, one board, one agent, one task and one queued
 * run, for the usage tests. Not a test file, so the `*.test.ts` glob never
 * runs it on its own.
 */

export interface UsageWorld {
   userId: string;
   workspaceId: string;
   boardId: string;
   agentId: string;
   agentName: string;
   issueId: string;
   runId: string;
}

export async function seedUsageWorld(sql: Sql, label: string): Promise<UsageWorld> {
   const suffix = randomUUID().slice(0, 8);
   const [user] = await sql`
      INSERT INTO users (id, email, name)
      VALUES (${randomUUID()}, ${`usage-${label}-${suffix}@berry.test`}, ${`Usage ${label}`})
      RETURNING id`;
   const userId = user!.id as string;
   const [workspace] = await sql`
      INSERT INTO workspaces (id, name, slug, settings, created_by)
      VALUES (${randomUUID()}, ${`Usage ${label} ${suffix}`}, ${`usage-${label}-${suffix}`},
              ${sql.json({ issuePrefix: 'USE', defaultRole: 'member', allowMemberInvites: false } as never)},
              ${userId})
      RETURNING id`;
   const workspaceId = workspace!.id as string;
   await sql`
      INSERT INTO workspace_memberships (workspace_id, user_id, role)
      VALUES (${workspaceId}, ${userId}, 'owner')`;
   const [board] = await sql`
      INSERT INTO boards (id, workspace_id, name, slug, created_by)
      VALUES (${randomUUID()}, ${workspaceId}, 'Usage board', ${`use-${suffix}`}, ${userId})
      RETURNING id`;
   const boardId = board!.id as string;
   const agentName = `Forge ${label}`;
   const [agent] = await sql`
      INSERT INTO agents (id, workspace_id, board_id, name, instructions)
      VALUES (${randomUUID()}, ${workspaceId}, ${boardId}, ${agentName}, 'Be brief.')
      RETURNING id`;
   const world: UsageWorld = {
      userId,
      workspaceId,
      boardId,
      agentId: agent!.id as string,
      agentName,
      issueId: '',
      runId: '',
   };
   const first = await addRun(sql, world);
   world.issueId = first.issueId;
   world.runId = first.runId;
   return world;
}

/** A new task with one queued run. One per task, because a task holds one active run. */
export async function addRun(
   sql: Sql,
   world: UsageWorld
): Promise<{ issueId: string; runId: string }> {
   const issueId = randomUUID();
   const runId = randomUUID();
   await sql.begin(async (tx) => {
      const [counter] = await tx`
         UPDATE boards SET issue_counter = issue_counter + 1
          WHERE id = ${world.boardId} RETURNING issue_counter`;
      await tx`
         INSERT INTO issues (id, board_id, number, title, status, created_by)
         VALUES (${issueId}, ${world.boardId}, ${Number(counter!.issue_counter)},
                 'Usage task', 'todo', ${world.userId})`;
      await tx`
         INSERT INTO runs (id, issue_id, board_id, agent_id)
         VALUES (${runId}, ${issueId}, ${world.boardId}, ${world.agentId})`;
   });
   return { issueId, runId };
}

/** Moves a run to a state, satisfying the ledger's CHECKs on failure and completion. */
export async function finishRun(
   sql: Sql,
   runId: string,
   status: 'running' | 'succeeded' | 'failed' | 'cancelled'
): Promise<void> {
   if (status === 'running') {
      await sql`UPDATE runs SET status = 'running', started_at = now() WHERE id = ${runId}`;
      return;
   }
   await sql`
      UPDATE runs
         SET status = ${status}::run_status,
             started_at = COALESCE(started_at, now()),
             completed_at = now(),
             failure_code = ${status === 'failed' ? 'TEST_FAILURE' : null},
             failure_message = ${status === 'failed' ? 'failed in a test' : null}
       WHERE id = ${runId}`;
}

export async function cleanupUsageWorld(sql: Sql, world: UsageWorld | undefined): Promise<void> {
   if (!world?.workspaceId) return;
   await sql`DELETE FROM outbox_events WHERE workspace_id = ${world.workspaceId}`;
   await sql`DELETE FROM task_usage_hourly WHERE workspace_id = ${world.workspaceId}`;
   await sql`
      DELETE FROM issues
       WHERE board_id IN (SELECT id FROM boards WHERE workspace_id = ${world.workspaceId})`;
   // Protected agents refuse deletion by trigger, deliberately; suspended only
   // for the fixture's own teardown, as the run repository tests do.
   await deleteWorkspaceAgents(sql, [world.workspaceId]);
   await sql`DELETE FROM boards WHERE workspace_id = ${world.workspaceId}`;
   await sql`DELETE FROM workspace_memberships WHERE workspace_id = ${world.workspaceId}`;
   await sql`DELETE FROM workspaces WHERE id = ${world.workspaceId}`;
   await sql`DELETE FROM users WHERE id = ${world.userId}`;
}

/** A scoped query surface for calling the read functions without a request. */
export function scopeOf(sql: Sql, workspaceId: string): ScopedQuery {
   return { sql, workspaceId, scope: sql`workspace_id = ${workspaceId}` };
}
