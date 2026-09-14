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

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('agent profile', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let app: BerryApp;
   let world: AgentLayerWorld;

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

   test('env values are sealed and only names come back', async () => {
      const res = await call(app, world.ownerToken, 'PUT', `/api/v1/agents/${world.agentId}/env`, {
         env: { API_TOKEN: 'tok-999', REGION: 'eu' },
      });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.envNames, ['API_TOKEN', 'REGION']);
      const agent = await call(app, world.ownerToken, 'GET', `/api/v1/agents/${world.agentId}`);
      assert.equal(JSON.stringify(agent.body).includes('tok-999'), false);
      assert.deepEqual(agent.body.envNames, ['API_TOKEN', 'REGION']);
      const [raw] = await sql`SELECT env_sealed FROM agents WHERE id = ${world.agentId}`;
      assert.equal(Buffer.from(raw?.env_sealed as Buffer).toString('utf8').includes('tok-999'), false);
   });

   test('a member cannot change env; an owner can', async () => {
      const res = await call(app, world.memberToken, 'PUT', `/api/v1/agents/${world.agentId}/env`, { env: {} });
      assert.equal(res.status, 403);
   });

   test('labels are stored as a set', async () => {
      const res = await call(app, world.ownerToken, 'PUT', `/api/v1/agents/${world.agentId}/labels`, {
         labels: ['backend', 'backend', 'infra'],
      });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.labels, ['backend', 'infra']);
   });

   test('an uploaded avatar is served back and becomes the avatar url', async () => {
      const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
      const put = await app.request(`/api/v1/agents/${world.agentId}/avatar`, {
         method: 'PUT',
         headers: { authorization: `Bearer ${world.ownerToken}`, 'content-type': 'image/png' },
         body: png,
      });
      assert.equal(put.status, 200);
      const body = (await put.json()) as { avatarUrl: string };
      assert.match(body.avatarUrl, /^\/api\/v1\/agents\/[0-9a-f-]{36}\/avatar\?v=\d+$/);
      const get = await app.request(`/api/v1/agents/${world.agentId}/avatar`, {
         headers: { authorization: `Bearer ${world.ownerToken}` },
      });
      assert.equal(get.headers.get('content-type'), 'image/png');
      assert.deepEqual(Buffer.from(await get.arrayBuffer()), png);
   });

   test('an avatar of another type is refused', async () => {
      const put = await app.request(`/api/v1/agents/${world.agentId}/avatar`, {
         method: 'PUT',
         headers: { authorization: `Bearer ${world.ownerToken}`, 'content-type': 'text/plain' },
         body: 'hello',
      });
      assert.equal(put.status, 415);
   });

   test('access scopes are set through permissions and read back', async () => {
      const res = await call(app, world.ownerToken, 'PUT', `/api/v1/agents/${world.agentId}/permissions`, {
         access: { assign: 'listed', mention: 'everyone', members: [world.memberId] },
      });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.access, { assign: 'listed', mention: 'everyone' });
      const access = await call(app, world.ownerToken, 'GET', `/api/v1/agents/${world.agentId}/access`);
      assert.deepEqual(access.body, { assign: 'listed', mention: 'everyone', members: [world.memberId] });
   });

   test('permissions still refuse an unknown name', async () => {
      const res = await call(app, world.ownerToken, 'PUT', `/api/v1/agents/${world.agentId}/permissions`, {
         permissions: ['not.a.permission'],
      });
      assert.equal(res.status, 400);
   });

   test('listing a user from another workspace is refused', async () => {
      const res = await call(app, world.ownerToken, 'PUT', `/api/v1/agents/${world.agentId}/permissions`, {
         access: { assign: 'listed', mention: 'everyone', members: [world.outsiderId] },
      });
      assert.equal(res.status, 422);
      assert.equal((res.body.error as { code: string }).code, 'VALIDATION_FAILED');
   });

   test('another workspace’s agent profile is not found', async () => {
      const res = await call(app, world.ownerToken, 'GET', `/api/v1/agents/${world.otherAgentId}/access`);
      assert.equal(res.status, 404);
   });
});
