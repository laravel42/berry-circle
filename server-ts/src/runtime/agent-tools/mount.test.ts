import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../../db/pool.ts';
import { createApp, type BerryApp } from '../../http/app.ts';
import { Registry } from '../../http/registry.ts';
import { enqueueTask } from '../../runs/queue.ts';
import { cleanupFixture, createIssue, seedFixture, type Fixture } from '../test-fixture.ts';
import { agentToolMounts } from './mount.ts';
import { mintTaskToken, revokeTaskTokens } from './tokens.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('agent tool API', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let app: BerryApp;
   let mine: Fixture | null = null;
   let theirs: Fixture | null = null;
   let token = '';
   let issueId = '';
   let runId = '';
   const statusCalls: unknown[] = [];

   before(async () => {
      sql = openDatabase({ url: url! });
      mine = await seedFixture(sql, 'tools-a');
      theirs = await seedFixture(sql, 'tools-b');
      issueId = await createIssue(sql, mine, 'Tool task');
      ({ runId } = await enqueueTask(sql, {
         workspaceId: mine.workspaceId, agentId: mine.agentId, issueId, kind: 'agent', source: 'assignment',
      }));
      token = await mintTaskToken(sql, {
         runId, workspaceId: mine.workspaceId, agentId: mine.agentId,
         scopes: ['task:read', 'task:write'], ttlSeconds: 600,
      });
      const registry = new Registry();
      registry.registerAll(
         agentToolMounts({
            sql,
            storage: null,
            issues: {
               update: async (params) => {
                  statusCalls.push(params);
                  return { issue: {} as never, events: [] };
               },
            },
         })
      );
      app = createApp(registry);
   });
   after(async () => {
      await cleanupFixture(sql, mine);
      await cleanupFixture(sql, theirs);
      await closeDatabase(sql);
   });

   const call = (path: string, init: RequestInit = {}, bearer = token) =>
      app.request(`/api/v1/agent-tools${path}`, {
         ...init,
         headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      });

   test('without a task token nothing answers', async () => {
      const response = await app.request('/api/v1/agent-tools');
      assert.equal(response.status, 401);
      assert.equal((await call('', {}, 'berry_pat_nope')).status, 401);
   });

   test('the manifest lists the core tools with JSON schemas', async () => {
      const body = (await (await call('')).json()) as { tools: Array<{ name: string; inputSchema: unknown }> };
      const names = body.tools.map((tool) => tool.name);
      for (const name of ['read_task', 'post_comment', 'set_status', 'mention_agent']) assert.ok(names.includes(name), name);
   });

   test('read_task reads the task this run is on, and only that one', async () => {
      const response = await call('/read_task', { method: 'POST', body: '{}' });
      assert.equal(response.status, 200);
      const body = (await response.json()) as { result: { title: string } };
      assert.equal(body.result.title, 'Tool task');
   });

   test('set_status moves the task as the agent', async () => {
      const response = await call('/set_status', { method: 'POST', body: JSON.stringify({ status: 'in_review' }) });
      assert.equal(response.status, 200);
      assert.deepEqual((statusCalls[0] as { actorType: string; issueId: string }).actorType, 'agent');
      assert.equal((statusCalls[0] as { issueId: string }).issueId, issueId);
   });

   test('invalid input is a 400 that names the field', async () => {
      const response = await call('/set_status', { method: 'POST', body: JSON.stringify({ status: 42 }) });
      assert.equal(response.status, 400);
   });

   test('mentioning an agent of another workspace is a 404', async () => {
      const response = await call('/mention_agent', {
         method: 'POST',
         body: JSON.stringify({ agentId: theirs!.agentId, message: 'help' }),
      });
      assert.equal(response.status, 404);
   });

   test('an unknown tool is a 404', async () => {
      assert.equal((await call(`/nope_${randomUUID().slice(0, 4)}`, { method: 'POST', body: '{}' })).status, 404);
   });

   test('a revoked token stops working', async () => {
      await revokeTaskTokens(sql, runId);
      assert.equal((await call('')).status, 401);
   });
});
