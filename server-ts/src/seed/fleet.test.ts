import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import type { CatalogModel } from '../agents/catalog.ts';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { deleteWorkspaceAgents } from '../test-support/protected-agents.ts';
import { agentName, applyFleet, chooseFleet, modelFamily } from './fleet.ts';

function model(id: string, input: number, output: number, supportsTools = true): CatalogModel {
   return {
      id,
      displayName: id.split('.').slice(-1)[0]!.replace(/-v\d+:\d+$/, ''),
      provider: 'bedrock',
      tier: 'standard',
      contextWindow: 200_000,
      inputCostPerM: input,
      outputCostPerM: output,
      supportsTools,
      supportsVision: false,
   };
}

test('a model line is the vendor and the line, whatever region serves it', () => {
   assert.equal(modelFamily('us.anthropic.claude-haiku-4-5-20251001-v1:0'), 'anthropic.claude');
   assert.equal(modelFamily('eu.anthropic.claude-sonnet-4-6'), 'anthropic.claude');
   assert.equal(modelFamily('amazon.nova-lite-v1:0'), 'amazon.nova');
   assert.equal(modelFamily('amazon.titan-text-express-v1'), 'amazon.titan');
   assert.equal(modelFamily('meta.llama3-8b-instruct-v1:0'), 'meta.llama3');
});

test('the fleet takes the cheapest of each line before a second of any', () => {
   const chosen = chooseFleet(
      [
         model('us.anthropic.claude-sonnet-4-6', 3, 15),
         model('us.anthropic.claude-haiku-4-5-v1:0', 0.8, 4),
         model('amazon.nova-lite-v1:0', 0.06, 0.24),
         model('amazon.nova-pro-v1:0', 0.8, 3.2),
         model('meta.llama3-8b-instruct-v1:0', 0.3, 0.6),
      ],
      3
    );
   assert.deepEqual(
      chosen.map((entry) => entry.id),
      ['amazon.nova-lite-v1:0', 'meta.llama3-8b-instruct-v1:0', 'us.anthropic.claude-haiku-4-5-v1:0']
   );
});

test('with lines to spare it fills up with the next cheapest', () => {
   const chosen = chooseFleet(
      [
         model('amazon.nova-lite-v1:0', 0.06, 0.24),
         model('amazon.nova-pro-v1:0', 0.8, 3.2),
         model('us.anthropic.claude-haiku-4-5-v1:0', 0.8, 4),
      ],
      3
   );
   assert.equal(chosen.length, 3);
   assert.ok(chosen.some((entry) => entry.id === 'amazon.nova-pro-v1:0'));
});

test('a model with no published price is not thereby the cheapest', () => {
   const chosen = chooseFleet(
      [
         model('us.amazon.nova-premier-v1:0', 0, 0),
         model('amazon.nova-lite-v1:0', 0.06, 0.24),
         model('us.anthropic.claude-haiku-4-5-v1:0', 0.8, 4),
      ],
      3
   );
   assert.equal(chosen[0]?.id, 'amazon.nova-lite-v1:0');
   assert.equal(chosen[2]?.id, 'us.amazon.nova-premier-v1:0', 'the unpriced model sorts last');
});

test('a model that cannot call a tool is not an agent', () => {
   const chosen = chooseFleet([model('amazon.titan-text-express-v1', 0.2, 0.6, false)], 5);
   assert.deepEqual(chosen, []);
});

test('an agent is named after its model', () => {
   assert.equal(agentName(model('us.anthropic.claude-haiku-4-5-v1:0', 1, 1)), 'claude-haiku-4-5');
});

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('seeding a fleet', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   const slug = `fleet-${randomUUID().slice(0, 8)}`;
   let workspaceId: string;

   before(async () => {
      sql = openDatabase({ url: url! });
      const [workspace] = await sql`
         INSERT INTO workspaces (id, slug, name) VALUES (${randomUUID()}, ${slug}, 'Fleet')
         RETURNING id`;
      workspaceId = workspace!.id as string;
      await sql`
         INSERT INTO agent_runtimes (workspace_id, name, kind, driver, status, is_default)
         VALUES (${workspaceId}, 'Fleet runtime', 'platform', 'http', 'active', true)`;
   });
   after(async () => {
      await deleteWorkspaceAgents(sql, [workspaceId]);
      await sql`DELETE FROM agent_runtimes WHERE workspace_id = ${workspaceId}`;
      await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`;
      await closeDatabase(sql);
    });

   test('every model becomes an agent bound to the default runtime, once', async () => {
      const models = [model('amazon.nova-lite-v1:0', 0.06, 0.24), model('us.anthropic.claude-haiku-4-5-v1:0', 0.8, 4)];

      const [first] = await applyFleet(sql, models, { workspaceSlug: slug });
      assert.deepEqual(first?.created, ['nova-lite', 'claude-haiku-4-5']);
      assert.equal(first?.runtimeMissing, false);

      // Only the seeded rows are asserted on: a new workspace also gets the
      // built-in agents its own trigger creates, and how many those are is
      // not this seeder's business.
      const seeded = await sql`
         SELECT name, model_name, runtime_id FROM agents
          WHERE workspace_id = ${workspaceId} AND name IN ('nova-lite', 'claude-haiku-4-5')
            AND archived_at IS NULL
          ORDER BY name`;
      assert.equal(seeded.length, 2);
      assert.deepEqual(
         seeded.map((row) => row.model_name),
         ['us.anthropic.claude-haiku-4-5-v1:0', 'amazon.nova-lite-v1:0']
      );
      for (const row of seeded) assert.ok(row.runtime_id, `${row.name} has no runtime`);

      const [second] = await applyFleet(sql, models, { workspaceSlug: slug });
      assert.deepEqual(second?.created, []);
      assert.deepEqual(second?.present, ['nova-lite', 'claude-haiku-4-5']);
   });
});
