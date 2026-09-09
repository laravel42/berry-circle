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

describe('starting a plan with milestones', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let userId = '';
   let workspaceId = '';
   let boardId = '';

   before(async () => {
      sql = openDatabase({ url: url! });
      const suffix = randomUUID().slice(0, 8);
      const [user] = await sql`
         INSERT INTO users (id, email, name)
         VALUES (${randomUUID()}, ${`plan-ms-${suffix}@berry.test`}, 'Plan Milestones') RETURNING id`;
      userId = user!.id as string;
      const [workspace] = await sql`
         INSERT INTO workspaces (id, name, slug, settings, created_by)
         VALUES (${randomUUID()}, ${`PlanMs ${suffix}`}, ${`plan-ms-${suffix}`},
                 ${sql.json({ issuePrefix: 'PLM', defaultRole: 'member', allowMemberInvites: false } as never)},
                 ${userId})
         RETURNING id`;
      workspaceId = workspace!.id as string;
      await sql`
         INSERT INTO workspace_memberships (workspace_id, user_id, role)
         VALUES (${workspaceId}, ${userId}, 'owner')`;
      const [board] = await sql`
         INSERT INTO boards (id, workspace_id, name, slug, created_by)
         VALUES (${randomUUID()}, ${workspaceId}, 'Milestone board', ${`pm-${suffix}`}, ${userId})
         RETURNING id`;
      boardId = board!.id as string;
   });

   after(async () => {
      if (!sql) return;
      await sql`DELETE FROM issues WHERE board_id = ${boardId}`;
      await sql`DELETE FROM plans WHERE workspace_id = ${workspaceId}`;
      await sql`DELETE FROM goals WHERE workspace_id = ${workspaceId}`;
      await closeDatabase(sql);
   });

   test('each milestone becomes a goal, the first reusing the goal the plan opened with', async () => {
      const plans = new PlanRepository(sql);
      const opened = await plans.open({
         workspaceId,
         goalId: null,
         projectId: null,
         boardId,
         prompt: 'Build a support desk.',
         createdBy: userId,
      });
      const task = (tempId: string, title: string, milestone: string, dependsOn: string[] = []) => ({
         tempId,
         title,
         description: null,
         type: 'issue',
         suggestedAgentId: null,
         requiredCapabilities: [],
         priority: null,
         dependsOn,
         requiresReview: false,
         requiresApproval: false,
         expectedArtifacts: [],
         estimate: null,
         milestone,
      });
      const plan = {
         version: '1',
         goal: { tempId: 'goal-1', title: 'Build a support desk.', description: null },
         milestones: [
            { tempId: 'm1', title: 'People can sign in', description: 'Accounts and sessions' },
            { tempId: 'm2', title: 'A ticket can be filed', description: null },
         ],
         assumptions: [],
         requiredConnections: [],
         issues: [
            task('t1', 'Create the users table', 'm1'),
            task('t2', 'Add the sign-in form', 'm1', ['t1']),
            task('t3', 'Create the tickets table', 'm2', ['t1']),
         ],
         approvals: [],
         dependencies: [],
      };
      await plans.recordGeneration({
         planId: opened.id,
         workspaceId,
         plan,
         validation: { status: 'valid', errors: [], warnings: [], requiredConnections: [], ambiguities: [], risk: 'low', needsAdminActivation: false },
         critique: null,
         stages: [],
         usage: { inputTokens: 0, outputTokens: 0 },
         model: 'test',
         provider: 'test',
         exhausted: false,
         durationMs: 1,
         createdBy: userId,
      });

      const compiled = await plans.compile({ planId: opened.id, userId, note: null });

      assert.equal(compiled.compile?.status, 'succeeded');
      assert.equal(compiled.compile?.goalIds.length, 2);
      assert.equal(compiled.compile?.goalIds[0], opened.goalId, 'the opened goal is the first milestone');
      assert.equal(compiled.compile?.issueIds.length, 3);

      // Read in the compiled order rather than by created_at: the opened goal
      // carries the database's clock and the new one the server's, and a test
      // must not depend on which is ahead.
      const rows = await sql`
         SELECT goal.id, goal.title, goal.status,
                (SELECT count(*) FROM goal_issues WHERE goal_id = goal.id) AS tasks
           FROM goals AS goal WHERE goal.workspace_id = ${workspaceId} AND goal.deleted_at IS NULL`;
      const byId = new Map(rows.map((row) => [row.id as string, row]));
      assert.deepEqual(
         compiled.compile!.goalIds.map((id) => {
            const goal = byId.get(id)!;
            return [goal.title, goal.status, Number(goal.tasks)];
         }),
         [
            ['People can sign in', 'planned', 2],
            ['A ticket can be filed', 'planned', 1],
         ]
      );
      assert.equal(rows.length, 2, 'no empty goal is left beside the milestones');
   });
});
