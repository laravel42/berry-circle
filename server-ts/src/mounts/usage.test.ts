import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { SessionService } from '../auth/sessions.ts';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { createApp, type BerryApp } from '../http/app.ts';
import { Registry } from '../http/registry.ts';
import { recordTaskUsage } from '../usage/record.ts';
import { cleanupUsageWorld, seedUsageWorld, type UsageWorld } from '../usage/test-fixtures.ts';
import { usageMounts } from './usage.ts';

/**
 * The usage and dashboard mounts, driven through the real app. What matters
 * beyond the numbers is the boundary: another workspace's agent, task or
 * runtime answers exactly like one that does not exist.
 */

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('usage mounts', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let app: BerryApp;
   let token = '';
   let mine: UsageWorld;
   let theirs: UsageWorld;

   before(async () => {
      sql = openDatabase({ url: url! });
      const sessions = new SessionService({ sql, sessionTtlMs: 3_600_000 });
      const registry = new Registry();
      registry.registerAll(usageMounts({ sessions, sql }));
      app = createApp(registry);
      mine = await seedUsageWorld(sql, 'mnt');
      theirs = await seedUsageWorld(sql, 'mnt-other');
      for (const world of [mine, theirs]) {
         await recordTaskUsage(sql, {
            runId: world.runId,
            workspaceId: world.workspaceId,
            agentId: world.agentId,
            model: 'model-a',
            inputTokens: 40,
            outputTokens: 4,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
         });
      }
      token = (await sessions.issueForUser(mine.userId)).token;
   });

   after(async () => {
      await cleanupUsageWorld(sql, mine);
      await cleanupUsageWorld(sql, theirs);
      await closeDatabase(sql);
   });

   async function get(path: string, auth = true) {
      const response = await app.request(path, {
         headers: auth ? { authorization: `Bearer ${token}` } : {},
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
   }

   test('the workspace summary counts only this workspace', async () => {
      const { status, body } = await get(`/api/v1/usage/${mine.workspaceId}/summary?days=7`);
      assert.equal(status, 200);
      assert.equal(body.currency, 'USD');
      assert.equal(body.days, 7);
      assert.equal((body.totals as { inputTokens: number }).inputTokens, 40);
      assert.equal((body.daily as unknown[]).length, 7);
   });

   test("another workspace's summary is a 404", async () => {
      assert.equal((await get(`/api/v1/usage/${theirs.workspaceId}/summary`)).status, 404);
   });

   test('agent, task and runtime reads refuse ids from another workspace', async () => {
      const base = `/api/v1/usage/${mine.workspaceId}`;
      assert.equal((await get(`${base}/agents/${mine.agentId}`)).status, 200);
      assert.equal((await get(`${base}/agents/${theirs.agentId}`)).status, 404);
      assert.equal((await get(`${base}/issues/${mine.issueId}`)).status, 200);
      assert.equal((await get(`${base}/issues/${theirs.issueId}`)).status, 404);
      assert.equal((await get(`${base}/runtimes/${randomUUID()}`)).status, 404);
      const runtime = await get(`${base}/runtimes/default`);
      assert.equal(runtime.status, 200);
      assert.equal((runtime.body.byHour as unknown[]).length, 24);
   });

   test('the task panel lists the run that spent', async () => {
      const { body } = await get(`/api/v1/usage/${mine.workspaceId}/issues/${mine.issueId}`);
      assert.deepEqual((body.byRun as Array<{ key: string }>).map((row) => row.key), [mine.runId]);
   });

   test('the dashboard answers with run counts and a task snapshot', async () => {
      const { status, body } = await get(`/api/v1/dashboard/${mine.workspaceId}/overview`);
      assert.equal(status, 200);
      assert.equal((body.runCounts as { queued: number }).queued, 1);
      assert.equal((body.taskSnapshot as { todo: number }).todo, 1);
      assert.equal((body.runsDaily as unknown[]).length, 30);
   });

   test('a window outside 1..90 days or an unknown parameter is refused', async () => {
      for (const query of ['days=0', 'days=91', 'days=abc', 'range=7']) {
         const { status, body } = await get(`/api/v1/usage/${mine.workspaceId}/summary?${query}`);
         assert.equal(status, 422, query);
         assert.equal((body.error as { code: string }).code, 'VALIDATION_FAILED');
      }
   });

   test('no session is a 401 before any read', async () => {
      assert.equal((await get(`/api/v1/usage/${mine.workspaceId}/summary`, false)).status, 401);
      assert.equal((await get(`/api/v1/dashboard/${mine.workspaceId}/overview`, false)).status, 401);
   });
});
