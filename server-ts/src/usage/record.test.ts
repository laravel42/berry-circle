import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { ZodError } from 'zod';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { RunLedger } from '../runs/ledger.ts';
import type { ModelPrice, PricingSource } from '../agents/pricing.ts';
import { UsageRunMismatch, configureUsagePricing, recordTaskUsage } from './record.ts';
import { addRun, cleanupUsageWorld, seedUsageWorld, type UsageWorld } from './test-fixtures.ts';

/**
 * The one write path for model usage. A usage report is priced when written,
 * folded into its hour, added to its run's totals and announced on the
 * workspace stream, in one transaction, so no reader sees a cost the run
 * does not also show.
 */

const SONNET_ID = 'us.anthropic.claude-sonnet-4-20250514-v1:0';
const SONNET: ModelPrice = { inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, cacheWritePerM: 3.75 };
const pricing: PricingSource = {
   priceFor: async (model) => (model === SONNET_ID ? SONNET : null),
};

test('malformed usage is refused before the database is touched', async () => {
   const sql = {
      begin: () => {
         throw new Error('database touched');
      },
   } as unknown as Sql;
   await assert.rejects(
      recordTaskUsage(sql, {
         runId: 'not-a-uuid',
         workspaceId: '00000000-0000-4000-8000-000000000001',
         agentId: '00000000-0000-4000-8000-000000000002',
         model: SONNET_ID,
         inputTokens: -1,
         outputTokens: 0,
         cacheReadTokens: 0,
         cacheWriteTokens: 0,
      }),
      (error: unknown) => error instanceof ZodError
   );
});

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('recording task usage', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let world: UsageWorld;
   let other: UsageWorld;

   before(async () => {
      sql = openDatabase({ url: url! });
      world = await seedUsageWorld(sql, 'rec');
      other = await seedUsageWorld(sql, 'rec-other');
   });

   after(async () => {
      configureUsagePricing(null);
      await cleanupUsageWorld(sql, world);
      await cleanupUsageWorld(sql, other);
      await closeDatabase(sql);
   });

   afterEach(() => configureUsagePricing(null));

   function report(runId: string, overrides: Partial<Parameters<typeof recordTaskUsage>[1]> = {}) {
      return {
         runId,
         workspaceId: world.workspaceId,
         agentId: world.agentId,
         model: SONNET_ID,
         inputTokens: 1000,
         outputTokens: 500,
         cacheReadTokens: 2000,
         cacheWriteTokens: 100,
         ...overrides,
      };
   }

   test('a usage report is priced on write and lands in its run totals', async () => {
      configureUsagePricing(pricing);
      const { runId } = await addRun(sql, world);
      await recordTaskUsage(sql, report(runId));

      const [row] = await sql`
         SELECT cost_micros, currency, issue_id FROM task_usage WHERE run_id = ${runId}`;
      assert.equal(Number(row!.cost_micros), 11475);
      assert.equal(row!.currency, 'USD');
      assert.ok(row!.issue_id, 'the task is copied from the run');

      const [run] = await sql`
         SELECT input_tokens, output_tokens, total_tokens, cost_micros, currency
           FROM runs WHERE id = ${runId}`;
      assert.equal(Number(run!.input_tokens), 1000);
      assert.equal(Number(run!.output_tokens), 500);
      assert.equal(Number(run!.total_tokens), 1500);
      assert.equal(Number(run!.cost_micros), 11475);
      assert.equal(run!.currency, 'USD');
   });

   test('two reports in the same hour fold into one hourly row', async () => {
      // In `other`, whose hourly rows no other test writes, so the counts are exact.
      configureUsagePricing(pricing);
      const { runId } = await addRun(sql, other);
      const mine = { workspaceId: other.workspaceId, agentId: other.agentId };
      await recordTaskUsage(sql, report(runId, mine));
      await recordTaskUsage(
         sql,
         report(runId, { ...mine, inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
      );

      const [hours] = await sql`
         SELECT COUNT(DISTINCT date_trunc('hour', occurred_at, 'UTC'))::int AS n
           FROM task_usage WHERE run_id = ${runId}`;
      const rows = await sql`
         SELECT events, unpriced_events, input_tokens, cost_micros FROM task_usage_hourly
          WHERE workspace_id = ${other.workspaceId} AND agent_id = ${other.agentId}
            AND model = ${SONNET_ID}`;
      // One row per hour touched: one, unless the two writes straddled an hour.
      assert.equal(rows.length, Number(hours!.n));
      assert.equal(rows.reduce((sum, row) => sum + Number(row.events), 0), 2);
      assert.equal(rows.reduce((sum, row) => sum + Number(row.input_tokens), 0), 1010);
      assert.equal(rows.reduce((sum, row) => sum + Number(row.unpriced_events), 0), 0);
      const [run] = await sql`SELECT input_tokens, cost_micros FROM runs WHERE id = ${runId}`;
      assert.equal(Number(run!.input_tokens), 1010);
      assert.equal(Number(run!.cost_micros), 11475 + 30);
   });

   test('a model without a published price is recorded with no cost, not a zero one', async () => {
      configureUsagePricing(pricing);
      const { runId } = await addRun(sql, world);
      await recordTaskUsage(sql, report(runId, { model: 'us.unknown.model-v1:0' }));

      const [row] = await sql`SELECT cost_micros, currency FROM task_usage WHERE run_id = ${runId}`;
      assert.equal(row!.cost_micros, null);
      assert.equal(row!.currency, null);
      const [hour] = await sql`
         SELECT unpriced_events, cost_micros FROM task_usage_hourly
          WHERE workspace_id = ${world.workspaceId} AND model = 'us.unknown.model-v1:0'`;
      assert.equal(Number(hour!.unpriced_events), 1);
      assert.equal(Number(hour!.cost_micros), 0);
      const [run] = await sql`SELECT cost_micros, currency FROM runs WHERE id = ${runId}`;
      assert.equal(run!.cost_micros, null);
      assert.equal(run!.currency, null);
   });

   test('with no price source configured, usage is still recorded', async () => {
      const { runId } = await addRun(sql, world);
      await recordTaskUsage(sql, report(runId));
      const [row] = await sql`SELECT input_tokens, cost_micros FROM task_usage WHERE run_id = ${runId}`;
      assert.equal(Number(row!.input_tokens), 1000);
      assert.equal(row!.cost_micros, null);
   });

   test('usage naming a run from another workspace is refused and writes nothing', async () => {
      await assert.rejects(
         recordTaskUsage(sql, report(other.runId)),
         (error: unknown) => error instanceof UsageRunMismatch
      );
      const rows = await sql`SELECT 1 FROM task_usage WHERE run_id = ${other.runId}`;
      assert.equal(rows.length, 0);
   });

   test('a later success write does not erase usage already recorded', async () => {
      configureUsagePricing(pricing);
      const { runId } = await addRun(sql, world);
      await recordTaskUsage(sql, report(runId));
      await new RunLedger({ sql }).completeSuccess({
         runId,
         summary: 'done',
         usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costMicros: null, currency: null },
      });
      const [run] = await sql`SELECT input_tokens, cost_micros, currency FROM runs WHERE id = ${runId}`;
      assert.equal(Number(run!.input_tokens), 1000);
      assert.equal(Number(run!.cost_micros), 11475);
      assert.equal(run!.currency, 'USD');
   });

   test('each report is announced on the workspace stream', async () => {
      configureUsagePricing(pricing);
      const { runId } = await addRun(sql, world);
      await recordTaskUsage(sql, report(runId));
      const events = await sql`
         SELECT topic, aggregate_type, payload FROM outbox_events
          WHERE workspace_id = ${world.workspaceId} AND aggregate_id = ${runId}`;
      assert.equal(events.length, 1);
      assert.equal(events[0]!.topic, 'usage.recorded');
      assert.equal(events[0]!.aggregate_type, 'run');
      const envelope = events[0]!.payload as { boardId: unknown; payload: { costMicros: unknown } };
      assert.equal(envelope.boardId, null);
      assert.equal(envelope.payload.costMicros, 11475);
   });
});
