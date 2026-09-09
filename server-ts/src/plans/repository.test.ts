import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { PlanRepository } from './repository.ts';

/**
 * Opening a plan. DB-backed and self-skipping, like the other repositories.
 *
 * What is pinned is the one field the create-project dialog sends that the
 * server used to refuse: `autoGate`. The gate it removes is the human review
 * of an agent's work, so it is off unless the request said otherwise, and a
 * request that said so must be honoured rather than rejected.
 */

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('opening a plan', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let userId = '';
   let workspaceId = '';
   let boardId = '';

   before(async () => {
      sql = openDatabase({ url: url! });
      const suffix = randomUUID().slice(0, 8);
      const [user] = await sql`
         INSERT INTO users (id, email, name)
         VALUES (${randomUUID()}, ${`plan-open-${suffix}@berry.test`}, 'Plan Open') RETURNING id`;
      userId = user!.id as string;
      const [workspace] = await sql`
         INSERT INTO workspaces (id, name, slug, settings, created_by)
         VALUES (${randomUUID()}, ${`PlanOpen ${suffix}`}, ${`plan-open-${suffix}`},
                 ${sql.json({ issuePrefix: 'PLN', defaultRole: 'member', allowMemberInvites: false } as never)},
                 ${userId})
         RETURNING id`;
      workspaceId = workspace!.id as string;
      await sql`
         INSERT INTO workspace_memberships (workspace_id, user_id, role)
         VALUES (${workspaceId}, ${userId}, 'owner')`;
      const [board] = await sql`
         INSERT INTO boards (id, workspace_id, name, slug, created_by)
         VALUES (${randomUUID()}, ${workspaceId}, 'Plan board', ${`pl-${suffix}`}, ${userId})
         RETURNING id`;
      boardId = board!.id as string;
   });

   after(async () => {
      if (!sql) return;
      // What this test made. The workspace, board and user stay, as they do
      // in the other repository tests: a workspace brings agents with it, and
      // unpicking that is not what this test is about.
      await sql`DELETE FROM plans WHERE workspace_id = ${workspaceId}`;
      await sql`DELETE FROM goals WHERE workspace_id = ${workspaceId}`;
      await closeDatabase(sql);
   });

   test('a plan asked to auto-gate is stored that way, and one that was not is not', async () => {
      const plans = new PlanRepository(sql);
      const gated = await plans.open({
         workspaceId: workspaceId,
         goalId: null,
         projectId: null,
         boardId: boardId,
         prompt: 'Ship it without waiting on me.',
         createdBy: userId,
         autoGate: true,
      });
      assert.equal(gated.autoGate, true);

      const reviewed = await plans.open({
         workspaceId: workspaceId,
         goalId: null,
         projectId: null,
         boardId: boardId,
         prompt: 'Ship it, and I will look first.',
         createdBy: userId,
      });
      assert.equal(reviewed.autoGate, false);
   });
});
