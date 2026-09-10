import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { dropAgentLayerWorld, seedAgentLayerWorld, type AgentLayerWorld } from '../mounts/agent-layer.fixture.ts';
import type { EnqueueInput } from './seams.ts';
import { commentTriggers, fireCommentTriggers, planCommentTriggers } from './triggers.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('comment triggers', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let world: AgentLayerWorld;
   before(async () => {
      sql = openDatabase({ url: url as string });
      world = await seedAgentLayerWorld(sql);
   });
   after(async () => {
      await sql`DELETE FROM comments WHERE issue_id = ${world.issueId}`;
      await dropAgentLayerWorld(sql, world);
      await closeDatabase(sql);
   });
   const plan = (body: string, authorId = world.memberId) =>
      planCommentTriggers(sql, { workspaceId: world.workspaceId, issueId: world.issueId, authorId, body });
   const comment = async (body: string): Promise<string> => {
      const [row] = await sql`
         INSERT INTO comments (issue_id, author_type, author_id, body)
         VALUES (${world.issueId}, 'user', ${world.memberId}, ${body}) RETURNING id`;
      return row?.id as string;
   };

   test('a mention of an agent in this workspace targets it', async () => {
      const result = await plan(`@[Coder](agent:${world.agentId}) look`);
      assert.deepEqual(
         result.targets.map((t) => [t.agentId, t.reason]),
         [[world.agentId, 'mention']]
      );
   });

   test('a mention of another workspace’s agent does nothing', async () => {
      const result = await plan(`@[X](agent:${world.otherAgentId}) look`);
      assert.deepEqual(result, { targets: [], refused: [] });
   });

   test('a mention refused by the agent’s scope is reported, not fired', async () => {
      await sql`UPDATE agents SET mention_scope = 'admins' WHERE id = ${world.agentId}`;
      try {
         const result = await plan(`@[Coder](agent:${world.agentId})`);
         assert.deepEqual(result.targets, []);
         assert.equal(result.refused[0]?.reason, 'no_access');
         const owner = await plan(`@[Coder](agent:${world.agentId})`, world.ownerId);
         assert.equal(owner.targets.length, 1);
      } finally {
         await sql`UPDATE agents SET mention_scope = 'everyone' WHERE id = ${world.agentId}`;
      }
   });

   test('a mentioned squad targets its leader, once even if the leader is also mentioned', async () => {
      const [squad] = await sql`
         INSERT INTO squads (workspace_id, name, leader_agent_id)
         VALUES (${world.workspaceId}, 'Core', ${world.agentId}) RETURNING id`;
      const result = await plan(`@[Core](squad:${squad?.id as string}) and @[Coder](agent:${world.agentId})`);
      assert.equal(result.targets.length, 1);
      assert.equal(result.targets[0]?.agentId, world.agentId);
   });

   test('a plain reply on an agent-assigned issue goes to the assignee', async () => {
      await sql`UPDATE issues SET assignee_type = 'agent', assignee_id = ${world.agentId} WHERE id = ${world.issueId}`;
      const result = await plan('Thanks, now add tests.');
      assert.deepEqual(
         result.targets.map((t) => t.reason),
         ['reply_to_assignee']
      );
   });

   test('firing twice for one comment enqueues once', async () => {
      const commentId = await comment('again');
      const calls: EnqueueInput[] = [];
      const enqueue = async (_sql: Sql, input: EnqueueInput) => {
         calls.push(input);
         return { runId: '22222222-2222-4222-8222-222222222222' };
      };
      const p = await plan('again');
      const input = { workspaceId: world.workspaceId, issueId: world.issueId, commentId, body: 'again', plan: p };
      assert.deepEqual(await fireCommentTriggers(sql, enqueue, input), ['22222222-2222-4222-8222-222222222222']);
      assert.deepEqual(await fireCommentTriggers(sql, enqueue, input), []);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.source, 'mention');
      assert.match(calls[0]?.prompt ?? '', /<comment>\nagain\n<\/comment>/);
      const [row] = await sql`SELECT reason, run_id FROM comment_run_triggers WHERE comment_id = ${commentId}`;
      assert.equal(row?.reason, 'reply_to_assignee');
      assert.equal(row?.run_id, '22222222-2222-4222-8222-222222222222');
   });

   test('a refused enqueue releases the claim so the comment can fire later', async () => {
      const commentId = await comment('busy');
      const p = await plan('busy');
      const input = { workspaceId: world.workspaceId, issueId: world.issueId, commentId, body: 'busy', plan: p };
      await assert.rejects(
         fireCommentTriggers(sql, async () => {
            throw new Error('active run');
         }, input)
      );
      const [row] = await sql`SELECT count(*)::int AS n FROM comment_run_triggers WHERE comment_id = ${commentId}`;
      assert.equal(row?.n, 0);
   });

   test('the injected trigger service reports a failure instead of throwing', async () => {
      const commentId = await comment('boom');
      const errors: unknown[] = [];
      const triggers = commentTriggers({
         sql,
         enqueue: async () => {
            throw new Error('queue down');
         },
         report: (error) => errors.push(error),
      });
      await triggers.fire({
         workspaceId: world.workspaceId,
         issueId: world.issueId,
         authorId: world.memberId,
         commentId,
         body: 'boom',
      });
      assert.equal(errors.length, 1);
   });
});
