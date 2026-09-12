import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { personalTokenResolver } from '../auth/credentials.ts';
import { SessionService } from '../auth/sessions.ts';
import { issueTestToken } from '../auth/test-credentials.ts';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { createApp, type BerryApp } from '../http/app.ts';
import { Registry } from '../http/registry.ts';
import { sealerFromKey } from '../integrations/sealing.ts';
import { cleanupFixture, seedFixture, type Fixture } from '../runtime/test-fixture.ts';
import { runtimeMounts } from './runtimes.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;
const KEY = Buffer.alloc(32, 7).toString('base64');

describe('/api/v1/runtimes', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let app: BerryApp;
   let mine: Fixture | null = null;
   let theirs: Fixture | null = null;
   let token = '';
   let theirRuntime = '';
   const healthChecked: string[] = [];
   const lifecycles: Array<{ arn: string; idle: number }> = [];

   before(async () => {
      sql = openDatabase({ url: url as string });
      mine = await seedFixture(sql, 'rt-a');
      theirs = await seedFixture(sql, 'rt-b');
      const sessions = new SessionService({ sql, auth: null, bearer: [personalTokenResolver(sql)] });
      // The session's current workspace is the user's last one.
      await sql`UPDATE users SET last_workspace_id = ${mine.workspaceId} WHERE id = ${mine.userId}`;
      token = await issueTestToken(sql, mine.userId);
      const [row] = await sql`
         INSERT INTO agent_runtimes (workspace_id, name, kind, driver, endpoint_url)
         VALUES (${theirs.workspaceId}, 'theirs', 'custom', 'http', 'http://x') RETURNING id`;
      theirRuntime = row!.id as string;
      const registry = new Registry();
      registry.registerAll(
         runtimeMounts({
            sessions,
            sql,
            sealer: sealerFromKey(KEY),
            health: async (target) => void healthChecked.push(target.endpointUrl ?? target.arn ?? ''),
            applyLifecycle: async (arn, lifecycle) =>
               void lifecycles.push({ arn, idle: lifecycle.idleRuntimeSessionTimeout }),
         })
      );
      app = createApp(registry);
   });
   after(async () => {
      if (!sql) return;
      await cleanupFixture(sql, mine);
      await cleanupFixture(sql, theirs);
      await closeDatabase(sql);
   });

   const call = (path: string, init: RequestInit = {}) =>
      app.request(`/api/v1/runtimes${path}`, {
         ...init,
         headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      });

   const firstCustom = async (): Promise<string> => {
      const list = (await (await call('')).json()) as { nodes: Array<{ id: string; kind: string }> };
      const found = list.nodes.find((node) => node.kind === 'custom');
      assert.ok(found);
      return found.id;
   };

   test('an owner registers a runtime and sees it listed', async () => {
      const created = await call('', {
         method: 'POST',
         body: JSON.stringify({
            name: 'Team runtime',
            driver: 'agentcore',
            arn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/team-x',
            concurrencyLimit: 2,
         }),
      });
      assert.equal(created.status, 201);
      const list = (await (await call('')).json()) as {
         nodes: Array<{ name: string; idleTimeoutS: number; maxLifetimeS: number }>;
      };
      const found = list.nodes.find((node) => node.name === 'Team runtime');
      assert.ok(found);
      assert.equal(found.idleTimeoutS, 3600);
      assert.equal(found.maxLifetimeS, 28800);
   });

   test('an agentcore runtime without an ARN is refused', async () => {
      const response = await call('', { method: 'POST', body: JSON.stringify({ name: 'no arn', driver: 'agentcore' }) });
      assert.equal(response.status, 400);
   });

   test('profile env is sealed at rest, never returned, and its idle timeout reaches the runtime', async () => {
      const runtimeId = await firstCustom();
      const created = await call(`/${runtimeId}/profiles`, {
         method: 'POST',
         body: JSON.stringify({ name: 'default', env: { API_KEY: 'hunter2' }, idleTimeoutS: 7200 }),
      });
      assert.equal(created.status, 201);
      const body = (await created.json()) as { lifecycleApplied?: boolean };
      assert.equal(body.lifecycleApplied, true);
      assert.deepEqual(lifecycles, [{ arn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/team-x', idle: 7200 }]);
      const text = await (await call(`/${runtimeId}/profiles`)).text();
      assert.equal(text.includes('hunter2'), false);
      assert.ok(text.includes('API_KEY'));
      const [row] = await sql`
         SELECT env_sealed FROM runtime_profiles WHERE name = 'default' AND workspace_id = ${mine!.workspaceId}`;
      assert.equal(Buffer.from(row!.env_sealed as Buffer).toString('utf8').includes('hunter2'), false);
   });

   test('an idle timeout past eight hours is refused', async () => {
      const response = await call('', {
         method: 'POST',
         body: JSON.stringify({ name: 'x', driver: 'http', endpointUrl: 'http://y', idleTimeoutS: 28801 }),
      });
      assert.equal(response.status, 400);
   });

   test('a health check records its outcome', async () => {
      const response = await call(`/${await firstCustom()}/health`, { method: 'POST', body: '{}' });
      assert.equal(response.status, 200);
      assert.equal(healthChecked.length, 1);
      const body = (await response.json()) as { lastHealthAt: string | null; status: string };
      assert.ok(body.lastHealthAt);
      assert.equal(body.status, 'active');
   });

   test('one default at a time: making a runtime default clears the old one', async () => {
      const response = await call(`/${await firstCustom()}`, { method: 'PATCH', body: JSON.stringify({ isDefault: true }) });
      assert.equal(response.status, 200);
      const [row] = await sql`
         SELECT count(*)::int AS n FROM agent_runtimes WHERE workspace_id = ${mine!.workspaceId} AND is_default`;
      assert.equal(row!.n, 1);
   });

   test('a platform runtime cannot be removed', async () => {
      const [platform] = await sql`
         INSERT INTO agent_runtimes (workspace_id, name, kind, driver)
         VALUES (${mine!.workspaceId}, 'Berry platform', 'platform', 'http') RETURNING id`;
      const response = await call(`/${platform!.id as string}`, { method: 'DELETE' });
      assert.equal(response.status, 409);
   });

   test("another workspace's runtime is a 404 to read, change or delete", async () => {
      assert.equal((await call(`/${theirRuntime}`)).status, 404);
      assert.equal((await call(`/${theirRuntime}`, { method: 'PATCH', body: JSON.stringify({ name: 'mine now' }) })).status, 404);
      assert.equal((await call(`/${theirRuntime}`, { method: 'DELETE' })).status, 404);
      assert.equal((await call(`/${theirRuntime}/profiles`)).status, 404);
      const [row] = await sql`SELECT name FROM agent_runtimes WHERE id = ${theirRuntime}`;
      assert.equal(row!.name, 'theirs');
   });

   test('binding an agent from another workspace is a 404', async () => {
      const response = await call(`/${await firstCustom()}/agents/${theirs!.agentId}`, { method: 'PUT', body: '{}' });
      assert.equal(response.status, 404);
   });

   test("binding my agent to another workspace's profile is a 404 and binds nothing", async () => {
      const [profile] = await sql`
         INSERT INTO runtime_profiles (workspace_id, runtime_id, name)
         VALUES (${theirs!.workspaceId}, ${theirRuntime}, 'their profile') RETURNING id`;
      const response = await call(`/${await firstCustom()}/agents/${mine!.agentId}`, {
         method: 'PUT',
         body: JSON.stringify({ profileId: profile!.id }),
      });
      assert.equal(response.status, 404);
      const [agent] = await sql`SELECT runtime_profile_id FROM agents WHERE id = ${mine!.agentId}`;
      assert.equal(agent!.runtime_profile_id, null);
   });

   test('binding my agent to my runtime is recorded, and unbinding clears it', async () => {
      const runtimeId = await firstCustom();
      assert.equal((await call(`/${runtimeId}/agents/${mine!.agentId}`, { method: 'PUT', body: '{}' })).status, 204);
      const [bound] = await sql`SELECT runtime_id FROM agents WHERE id = ${mine!.agentId}`;
      assert.equal(bound!.runtime_id, runtimeId);
      assert.equal((await call(`/${runtimeId}/agents/${mine!.agentId}`, { method: 'DELETE' })).status, 204);
      const [unbound] = await sql`SELECT runtime_id FROM agents WHERE id = ${mine!.agentId}`;
      assert.equal(unbound!.runtime_id, null);
   });

   test("a member is told 404 for a runtime, profile or agent that is absent or another workspace's, and 403 only for this one's", async () => {
      const [member] = await sql`
         INSERT INTO users (id, email, name)
         VALUES (${randomUUID()}, ${`rt-member-${randomUUID().slice(0, 8)}@berry.test`}, 'Member')
         RETURNING id`;
      const memberId = member!.id as string;
      try {
         await sql`
            INSERT INTO workspace_memberships (workspace_id, user_id, role)
            VALUES (${mine!.workspaceId}, ${memberId}, 'member')`;
         await sql`UPDATE users SET last_workspace_id = ${mine!.workspaceId} WHERE id = ${memberId}`;
         const memberToken = await issueTestToken(sql, memberId);
         const asMember = (method: string, path: string, body?: unknown) =>
            app.request(`/api/v1/runtimes${path}`, {
               method,
               headers: { authorization: `Bearer ${memberToken}`, 'content-type': 'application/json' },
               ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
         const own = await firstCustom();
         const [ownProfile] = await sql`
            INSERT INTO runtime_profiles (workspace_id, runtime_id, name)
            VALUES (${mine!.workspaceId}, ${own}, ${`probe-${randomUUID().slice(0, 8)}`}) RETURNING id`;
         const [theirProfile] = await sql`
            INSERT INTO runtime_profiles (workspace_id, runtime_id, name)
            VALUES (${theirs!.workspaceId}, ${theirRuntime}, ${`probe-${randomUUID().slice(0, 8)}`}) RETURNING id`;
         const probes: Array<{ method: string; path: (id: string) => string; own: string; foreign: string; body?: unknown }> = [
            { method: 'PATCH', path: (id) => `/${id}`, own, foreign: theirRuntime, body: { name: 'mine now' } },
            { method: 'DELETE', path: (id) => `/${id}`, own, foreign: theirRuntime },
            { method: 'POST', path: (id) => `/${id}/profiles`, own, foreign: theirRuntime, body: { name: 'p' } },
            { method: 'PATCH', path: (id) => `/${own}/profiles/${id}`, own: ownProfile!.id as string, foreign: theirProfile!.id as string, body: { name: 'p' } },
            { method: 'DELETE', path: (id) => `/${own}/profiles/${id}`, own: ownProfile!.id as string, foreign: theirProfile!.id as string },
            { method: 'PUT', path: (id) => `/${own}/agents/${id}`, own: mine!.agentId, foreign: theirs!.agentId, body: {} },
            { method: 'DELETE', path: (id) => `/${own}/agents/${id}`, own: mine!.agentId, foreign: theirs!.agentId },
         ];
         for (const probe of probes) {
            const label = `${probe.method} ${probe.path(':id')}`;
            assert.equal((await asMember(probe.method, probe.path(probe.foreign), probe.body)).status, 404, `${label}: another workspace's`);
            assert.equal((await asMember(probe.method, probe.path(randomUUID()), probe.body)).status, 404, `${label}: none at all`);
            assert.equal((await asMember(probe.method, probe.path(probe.own), probe.body)).status, 403, `${label}: this workspace's`);
         }
      } finally {
         await sql`DELETE FROM personal_api_tokens WHERE user_id = ${memberId}`;
         await sql`DELETE FROM workspace_memberships WHERE user_id = ${memberId}`;
         await sql`DELETE FROM users WHERE id = ${memberId}`;
      }
   });

   test('a runtime names the agents it serves, and coverage says who has one', async () => {
      const runtimeId = await firstCustom();
      assert.equal((await call(`/${runtimeId}/agents/${mine!.agentId}`, { method: 'PUT', body: '{}' })).status, 204);
      try {
         const detail = (await (await call(`/${runtimeId}`)).json()) as {
            servingAgents: Array<{ id: string; name: string }>;
         };
         assert.deepEqual(
            detail.servingAgents.map((agent) => agent.id),
            [mine!.agentId]
         );

         const coverage = (await (await call('/agent-coverage')).json()) as {
            defaultRuntimeId: string | null;
            nodes: Array<{ id: string; runtimeId: string | null }>;
         };
         assert.equal(coverage.defaultRuntimeId, runtimeId, 'made the default earlier in this file');
         const bound = coverage.nodes.find((node) => node.id === mine!.agentId);
         assert.equal(bound?.runtimeId, runtimeId);
         assert.equal(
            coverage.nodes.some((node) => node.id === theirs!.agentId),
            false,
            "another workspace's agents are not covered here"
         );
      } finally {
         await call(`/${runtimeId}/agents/${mine!.agentId}`, { method: 'DELETE' });
      }
   });

   test('without a session nothing answers', async () => {
      assert.equal((await app.request('/api/v1/runtimes')).status, 401);
   });
});
