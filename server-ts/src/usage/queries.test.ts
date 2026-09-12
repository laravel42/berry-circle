import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { recordTaskUsage } from './record.ts';
import {
   agentUsage,
   dashboardOverview,
   issueInWorkspace,
   issueUsage,
   runtimeUsage,
   runtimeVisible,
   usageWindow,
   workspaceUsage,
} from './queries.ts';
import {
   addRun,
   cleanupUsageWorld,
   finishRun,
   scopeOf,
   seedUsageWorld,
   type UsageWorld,
} from './test-fixtures.ts';

test('a window starts at UTC midnight days-1 back and ends now', () => {
   const now = new Date('2026-09-10T15:30:00.000Z');
   assert.deepEqual(usageWindow(7, now), {
      days: 7,
      from: '2026-09-04T00:00:00.000Z',
      to: '2026-09-10T15:30:00.000Z',
      timezone: 'UTC',
   });
});

test('a window asked for in a zone starts at midnight there', () => {
   // 15:30 UTC is already the 11th in Tokyo, so seven days back is the 5th,
   // and its midnight is 15:00 UTC on the 4th.
   const window = usageWindow(7, new Date('2026-09-10T15:30:00.000Z'), 'Asia/Tokyo');
   assert.equal(window.from, '2026-09-04T15:00:00.000Z');
   assert.equal(window.timezone, 'Asia/Tokyo');
});

test('a window spanning a clock change still starts at local midnight', () => {
   // New York moved to daylight time at 02:00 on 8 March 2026; midnight that
   // morning was still -05:00, which is the offset the start must use — not
   // the -04:00 in force at the end of the window.
   const window = usageWindow(3, new Date('2026-03-10T12:00:00.000Z'), 'America/New_York');
   assert.equal(window.from, '2026-03-08T05:00:00.000Z');
});

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('usage reads', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let world: UsageWorld;
   let other: UsageWorld;
   const RUNTIME = randomUUID();

   function usage(w: UsageWorld, runId: string, extra: { runtimeId?: string; model?: string } = {}) {
      return recordTaskUsage(sql, {
         runId,
         workspaceId: w.workspaceId,
         agentId: w.agentId,
         model: extra.model ?? 'model-a',
         inputTokens: 100,
         outputTokens: 10,
         cacheReadTokens: 5,
         cacheWriteTokens: 1,
         ...(extra.runtimeId ? { runtimeId: extra.runtimeId } : {}),
      });
   }

   before(async () => {
      sql = openDatabase({ url: url! });
      world = await seedUsageWorld(sql, 'q');
      other = await seedUsageWorld(sql, 'q-other');
      await usage(world, world.runId);
      await usage(world, world.runId, { model: 'model-b', runtimeId: RUNTIME });
      await usage(other, other.runId);
      await usage(other, other.runId);
      await usage(other, other.runId);
   });

   after(async () => {
      await cleanupUsageWorld(sql, world);
      await cleanupUsageWorld(sql, other);
      await closeDatabase(sql);
   });

   test('workspace usage sums only its own rows and zero-fills every day', async () => {
      const result = await workspaceUsage(scopeOf(sql, world.workspaceId), usageWindow(7));
      assert.equal(result.totals.events, 2);
      assert.equal(result.totals.inputTokens, 200);
      assert.equal(result.totals.cacheReadTokens, 10);
      assert.equal(result.totals.unpricedEvents, 2);
      assert.equal(result.daily.length, 7);
      assert.equal(result.daily.at(-1)?.inputTokens, 200);
      assert.equal(result.daily[0]?.inputTokens, 0);
      assert.deepEqual(result.byAgent.map((row) => [row.key, row.agentName]), [
         [world.agentId, world.agentName],
      ]);
      assert.deepEqual(result.byModel.map((row) => row.key).sort(), ['model-a', 'model-b']);
   });

   test('agent usage of a foreign agent is empty from this workspace', async () => {
      const result = await agentUsage(scopeOf(sql, world.workspaceId), other.agentId, usageWindow(7));
      assert.equal(result.totals.events, 0);
   });

   test('runtime usage separates the default runtime from a named one, by hour', async () => {
      const q = scopeOf(sql, world.workspaceId);
      const named = await runtimeUsage(q, RUNTIME, usageWindow(7));
      const fallback = await runtimeUsage(q, null, usageWindow(7));
      assert.equal(named.totals.events, 1);
      assert.equal(fallback.totals.events, 1);
      assert.equal(named.byHour.length, 24);
      assert.equal(named.byHour[0]?.key, '00');
      assert.equal(named.byHour.reduce((sum, row) => sum + row.events, 0), 1);
   });

   test('a runtime id is not visible when no runtime table or row names it', async () => {
      assert.equal(await runtimeVisible(scopeOf(sql, world.workspaceId), randomUUID()), false);
   });

   test('issue usage lists each run and refuses a task from another workspace', async () => {
      const q = scopeOf(sql, world.workspaceId);
      assert.equal(await issueInWorkspace(q, world.issueId), true);
      assert.equal(await issueInWorkspace(q, other.issueId), false);
      const result = await issueUsage(q, world.issueId);
      assert.equal(result.totals.events, 2);
      assert.deepEqual(result.byRun.map((row) => row.key), [world.runId]);
   });

   test('the dashboard counts runs by status and lists who is working now', async () => {
      const failed = await addRun(sql, world);
      await finishRun(sql, failed.runId, 'failed');
      const running = await addRun(sql, world);
      await finishRun(sql, running.runId, 'running');

      const result = await dashboardOverview(scopeOf(sql, world.workspaceId), usageWindow(30));
      assert.equal(result.runCounts.failed, 1);
      assert.equal(result.runCounts.running, 1);
      assert.equal(result.runCounts.queued, 1);
      assert.equal(result.runsDaily.length, 30);
      assert.equal(result.runsDaily.at(-1)?.failed, 1);
      assert.deepEqual(result.failuresByAgent.map((row) => [row.agentId, row.failed]), [
         [world.agentId, 1],
      ]);
      assert.deepEqual(result.workingAgents.map((row) => row.runId), [running.runId]);
      assert.equal(result.taskSnapshot.todo, 3);
      assert.equal(result.taskSnapshot.inProgress, 0);
      assert.equal(result.usageDaily.at(-1)?.events, 2);
   });
});
