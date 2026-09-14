import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { NotFound } from '../identity/errors.ts';
import { cleanupWorld, seedWorld, type World } from './fixture.ts';
import {
   QuickActionNameTaken,
   createQuickAction,
   listQuickActions,
   quickActionCreateSchema,
   renderPrompt,
   runQuickAction,
   type QuickActionEnqueue,
} from './quick-actions.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('quick actions', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let world: World;
   before(async () => {
      sql = openDatabase({ url: url as string });
      world = await seedWorld(sql, 'qa');
   });
   after(async () => {
      await cleanupWorld(sql, world);
      await closeDatabase(sql);
   });

   test('a template names the issue', () => {
      assert.equal(
         renderPrompt('Review {{ issue.identifier }}: {{issue.title}}\n{{issue.description}}', { identifier: 'WRK-1', title: 'Fix', description: null }),
         'Review WRK-1: Fix\n'
      );
   });

   test('a private action is invisible to others, and a shared name is unique', async () => {
      await createQuickAction(sql, world.workspaceId, world.memberId, quickActionCreateSchema.parse({ name: 'Mine', targetAgentId: world.agentId, prompt: 'x', visibility: 'private' }));
      assert.equal((await listQuickActions(sql, world.workspaceId, world.ownerId)).some((action) => action.name === 'Mine'), false);
      await createQuickAction(sql, world.workspaceId, world.ownerId, quickActionCreateSchema.parse({ name: 'Triage', targetAgentId: world.agentId, prompt: 'x' }));
      await assert.rejects(
         createQuickAction(sql, world.workspaceId, world.memberId, quickActionCreateSchema.parse({ name: 'triage', targetAgentId: world.agentId, prompt: 'y' })),
         QuickActionNameTaken
      );
   });

   test('running an action enqueues an agent task for the issue with the rendered prompt', async () => {
      const action = await createQuickAction(sql, world.workspaceId, world.ownerId, quickActionCreateSchema.parse({ name: 'Summarise', targetAgentId: world.agentId, prompt: 'Summarise {{issue.identifier}}' }));
      const calls: Array<Parameters<QuickActionEnqueue>[1]> = [];
      const enqueue: QuickActionEnqueue = async (_sql, input) => {
         calls.push(input);
         return { runId: 'run-1' };
      };
      const issue = { id: world.issueId, identifier: 'WRK-1', title: 'Root task', description: null };
      assert.deepEqual(await runQuickAction(sql, enqueue, { workspaceId: world.workspaceId, actionId: action.id, viewerId: world.memberId, issue }), { runId: 'run-1' });
      assert.deepEqual(calls[0], {
         workspaceId: world.workspaceId,
         agentId: world.agentId,
         issueId: world.issueId,
         kind: 'agent',
         source: 'quick_action',
         prompt: 'Summarise WRK-1',
         // The person who reached for the action asked for the run, so what the
         // agent files in it is filed in their name.
         requestedBy: world.memberId,
      });
      await assert.rejects(
         runQuickAction(sql, enqueue, { workspaceId: world.workspaceId, actionId: '00000000-0000-4000-8000-000000000000', viewerId: world.memberId, issue }),
         NotFound
      );
   });
});
