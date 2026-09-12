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
 * Revealing an agent's environment, and the record that says it happened.
 *
 * The product rule: values stay sealed until someone asks for them by name,
 * and every ask — and every write — is on the record afterwards.
 */

const url = process.env.BERRY_TEST_DATABASE_URL;

interface AuditNode {
   actorId: string | null;
   actorName: string | null;
   action: string;
   envNames: string[];
   occurredAt: string;
}

describe('agent environment audit', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let app: BerryApp;
   let world: AgentLayerWorld;

   const audit = async (token: string, agentId: string) =>
      call(app, token, 'GET', `/api/v1/agents/${agentId}/env/audit`);

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

   test('a write is recorded by name, and a reveal returns the values and is recorded too', async () => {
      const written = await call(app, world.ownerToken, 'PUT', `/api/v1/agents/${world.agentId}/env`, {
         env: { API_TOKEN: 'tok-secret-1', REGION: 'eu' },
      });
      assert.equal(written.status, 200);

      const revealed = await call(
         app,
         world.ownerToken,
         'POST',
         `/api/v1/agents/${world.agentId}/env/reveal`
      );
      assert.equal(revealed.status, 200);
      assert.deepEqual(revealed.body.env, { API_TOKEN: 'tok-secret-1', REGION: 'eu' });

      const listed = await audit(world.ownerToken, world.agentId);
      assert.equal(listed.status, 200);
      const nodes = listed.body.nodes as AuditNode[];
      // Newest first: the reveal, then the write that preceded it.
      assert.equal(nodes[0]?.action, 'reveal');
      assert.equal(nodes[1]?.action, 'update');
      assert.equal(nodes[0]?.actorId, world.ownerId);
      assert.equal(typeof nodes[0]?.actorName, 'string');
      assert.deepEqual(nodes[0]?.envNames, ['API_TOKEN', 'REGION']);

      // Names, never values: an audit trail that copies the secret is a second
      // place to steal it from.
      assert.equal(JSON.stringify(listed.body).includes('tok-secret-1'), false);
      const rows = await sql`SELECT env_names FROM agent_env_audit WHERE agent_id = ${world.agentId}`;
      assert.equal(JSON.stringify(rows).includes('tok-secret-1'), false);
   });

   test('a plain member can neither reveal nor read the record, and revealing leaves no entry', async () => {
      const before = (await audit(world.ownerToken, world.agentId)).body.nodes as AuditNode[];

      const refused = await call(
         app,
         world.memberToken,
         'POST',
         `/api/v1/agents/${world.agentId}/env/reveal`
      );
      assert.equal(refused.status, 403);
      assert.equal((await audit(world.memberToken, world.agentId)).status, 403);

      const after = (await audit(world.ownerToken, world.agentId)).body.nodes as AuditNode[];
      assert.equal(after.length, before.length, 'a refused reveal is not an audit entry');
   });

   test('an agent in another workspace is a 404, the same as one that does not exist', async () => {
      const foreign = await call(
         app,
         world.ownerToken,
         'POST',
         `/api/v1/agents/${world.otherAgentId}/env/reveal`
      );
      assert.equal(foreign.status, 404);
      assert.equal((await audit(world.ownerToken, world.otherAgentId)).status, 404);
      const rows = await sql`SELECT count(*)::int AS n FROM agent_env_audit WHERE agent_id = ${world.otherAgentId}`;
      assert.equal(Number(rows[0]?.n), 0, 'nothing was recorded against the foreign agent');
   });

   test('first is validated', async () => {
      assert.equal(
         (await call(app, world.ownerToken, 'GET', `/api/v1/agents/${world.agentId}/env/audit?first=1`)).status,
         200
      );
      assert.equal(
         (await call(app, world.ownerToken, 'GET', `/api/v1/agents/${world.agentId}/env/audit?first=0`)).status,
         400
      );
      assert.equal(
         (await call(app, world.ownerToken, 'GET', `/api/v1/agents/${world.agentId}/env/audit?first=999`)).status,
         400
      );
   });
});
