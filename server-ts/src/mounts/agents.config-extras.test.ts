import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { AgentProfileRepository } from '../agents/profile.ts';
import { AgentRepository } from '../agents/repository.ts';
import { personalTokenResolver } from '../auth/credentials.ts';
import { SessionService } from '../auth/sessions.ts';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { createApp, type BerryApp } from '../http/app.ts';
import { IdempotencyStore } from '../http/idempotency.ts';
import { Registry } from '../http/registry.ts';
import { sealerFromKey } from '../integrations/sealing.ts';
import { call, dropAgentLayerWorld, seedAgentLayerWorld, type AgentLayerWorld } from './agent-layer.fixture.ts';
import { agentMounts } from './agents.ts';

/**
 * Conversation starters and the concurrency ceiling: two pieces of an agent's
 * configuration written through `PUT /:agentId/config`.
 */

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('agent config extras', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let app: BerryApp;
   let world: AgentLayerWorld;

   const config = (token: string, body: unknown) =>
      call(app, token, 'PUT', `/api/v1/agents/${world.agentId}/config`, body);
   const read = (token: string) => call(app, token, 'GET', `/api/v1/agents/${world.agentId}`);

   before(async () => {
      sql = openDatabase({ url: url as string });
      world = await seedAgentLayerWorld(sql);
      const registry = new Registry();
      registry.registerAll(
         agentMounts({
            sessions: new SessionService({ sql, auth: null, bearer: [personalTokenResolver(sql)] }),
            agents: new AgentRepository(sql),
            idempotency: new IdempotencyStore(sql),
            catalog: null,
            profile: new AgentProfileRepository({
               sql,
               sealer: sealerFromKey(randomBytes(32).toString('base64')),
            }),
         })
      );
      app = createApp(registry);
   });

   after(async () => {
      await dropAgentLayerWorld(sql, world);
      await closeDatabase(sql);
   });

   test('an agent starts with no starters and no ceiling of its own', async () => {
      const res = await read(world.ownerToken);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.conversationStarters, []);
      assert.equal(res.body.maxConcurrency, null);
   });

   test('starters are stored in order, and blank rows are dropped rather than refused', async () => {
      const written = await config(world.ownerToken, {
         starters: ['Review my open pull requests', '   ', 'Summarise yesterday'],
      });
      assert.equal(written.status, 200);
      assert.deepEqual(written.body.conversationStarters, [
         'Review my open pull requests',
         'Summarise yesterday',
      ]);
      assert.deepEqual((await read(world.ownerToken)).body.conversationStarters, [
         'Review my open pull requests',
         'Summarise yesterday',
      ]);
   });

   test('a fourth starter is refused, and the stored three are untouched', async () => {
      await config(world.ownerToken, { starters: ['one', 'two', 'three'] });
      const refused = await config(world.ownerToken, { starters: ['a', 'b', 'c', 'd'] });
      assert.equal(refused.status, 400);
      assert.deepEqual((await read(world.ownerToken)).body.conversationStarters, [
         'one',
         'two',
         'three',
      ]);
   });

   test('an empty list clears them', async () => {
      await config(world.ownerToken, { starters: ['one'] });
      const cleared = await config(world.ownerToken, { starters: [] });
      assert.deepEqual(cleared.body.conversationStarters, []);
   });

   test('concurrency is a whole number in range, and null clears it', async () => {
      assert.equal((await config(world.ownerToken, { maxConcurrency: 4 })).body.maxConcurrency, 4);
      assert.equal((await config(world.ownerToken, { maxConcurrency: 0 })).status, 400);
      assert.equal((await config(world.ownerToken, { maxConcurrency: 21 })).status, 400);
      assert.equal((await config(world.ownerToken, { maxConcurrency: 1.5 })).status, 400);
      // Refused values leave the stored one alone.
      assert.equal((await read(world.ownerToken)).body.maxConcurrency, 4);
      assert.equal(
         (await config(world.ownerToken, { maxConcurrency: null })).body.maxConcurrency,
         null
      );
   });

   test('a config write with no known field is still refused', async () => {
      assert.equal((await config(world.ownerToken, {})).status, 400);
   });

   test('an agent can be renamed, but not to nothing', async () => {
      const renamed = await config(world.ownerToken, { name: '  Reviewer  ' });
      assert.equal(renamed.status, 200);
      assert.equal(renamed.body.name, 'Reviewer');
      assert.equal((await read(world.ownerToken)).body.name, 'Reviewer');

      assert.equal((await config(world.ownerToken, { name: '   ' })).status, 400);
      assert.equal((await read(world.ownerToken)).body.name, 'Reviewer', 'the name is untouched');
   });

   test('an agent in another workspace cannot be configured', async () => {
      const foreign = await call(
         app,
         world.ownerToken,
         'PUT',
         `/api/v1/agents/${world.otherAgentId}/config`,
         { starters: ['leak'] }
      );
      assert.equal(foreign.status, 404);
      const [row] = await sql`
         SELECT conversation_starters FROM agents WHERE id = ${world.otherAgentId}`;
      assert.deepEqual(row?.conversation_starters, []);
   });
});
