import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { createApp, type BerryApp } from '../http/app.ts';
import { Registry } from '../http/registry.ts';
import { SecretsRepository } from '../identity/secrets.ts';
import { dropWorld, HELLO, seedWorld, testSealer, testSessions, type World } from '../plugins/fixture.test-support.ts';
import { PluginRepository } from '../plugins/repository.ts';
import { PluginRuntimeStore } from '../plugins/runtime-store.ts';
import { pluginMounts } from './plugins.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('/api/v1/plugins', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let app: BerryApp;
   let world: World;
   let memberId = '';
   let viewerId = '';
   const tokens = { owner: '', member: '', viewer: '' };

   before(async () => {
      sql = openDatabase({ url: url as string });
      const registry = new Registry();
      registry.registerAll(
         pluginMounts({
            sessions: testSessions(sql),
            sql,
            plugins: new PluginRepository({ sql, sealer: testSealer() }),
            runtime: new PluginRuntimeStore({ sql }),
            network: { request: async () => ({ status: 200, body: JSON.stringify(HELLO) }) },
            publicUrl: 'https://berry.example.com',
         })
      );
      app = createApp(registry);
      world = await seedWorld(sql, 'admin');
      const [member] = await sql`
         INSERT INTO users (id, email, name) VALUES (${randomUUID()}, ${`m-${randomUUID()}@berry.test`}, 'M')
         RETURNING id`;
      memberId = member?.id as string;
      await sql`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES (${world.workspaceId}, ${memberId}, 'member')`;
      const secrets = new SecretsRepository(sql);
      const pat = async (userId: string, key: string) =>
         (await secrets.createPersonalToken({
            userId, name: key, expiresAt: null, idempotencyKey: key.repeat(16), fingerprint: Buffer.alloc(32, key), scopes: null,
         })).secret;
      tokens.owner = await pat(world.userId, 'o');
      tokens.member = await pat(memberId, 'm');
      const [viewer] = await sql`
         INSERT INTO users (id, email, name) VALUES (${randomUUID()}, ${`v-${randomUUID()}@berry.test`}, 'V')
         RETURNING id`;
      viewerId = viewer?.id as string;
      await sql`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES (${world.workspaceId}, ${viewerId}, 'viewer')`;
      tokens.viewer = await pat(viewerId, 'v');
   });
   after(async () => {
      for (const userId of [memberId, viewerId]) {
         await sql`DELETE FROM personal_api_tokens WHERE user_id = ${userId}`;
         await sql`DELETE FROM workspace_memberships WHERE user_id = ${userId}`;
      }
      await dropWorld(sql, world);
      await sql`DELETE FROM users WHERE id IN (${memberId}, ${viewerId})`;
      await closeDatabase(sql);
   });

   const call = (path: string, token: string, init: RequestInit = {}) =>
      app.request(`/api/v1/plugins/${world.workspaceId}${path}`, {
         ...init,
         headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      });

   let installationId = '';

   test('preview reads a package from a URL without installing it', async () => {
      const response = await call('/preview', tokens.owner, {
         method: 'POST', body: JSON.stringify({ url: 'https://hello.example.com/berry-plugin.json' }),
      });
      assert.equal(response.status, 200);
      const preview = (await response.json()) as { key: string; scopes: string[] };
      assert.equal(preview.key, 'hello');
      assert.deepEqual(preview.scopes, ['issues:read', 'comments:write']);
      const list = (await (await call('/installations', tokens.owner)).json()) as { nodes: unknown[] };
      assert.equal(list.nodes.length, 0);
   });

   test('a member cannot install; an owner can, and sees the signing secret once', async () => {
      const denied = await call('/installations', tokens.member, {
         method: 'POST', body: JSON.stringify({ package: HELLO, config: { greeting: 'hi' } }),
      });
      assert.equal(denied.status, 403);
      const created = await call('/installations', tokens.owner, {
         method: 'POST', body: JSON.stringify({ package: HELLO, config: { greeting: 'hi' } }),
      });
      assert.equal(created.status, 201);
      assert.equal(created.headers.get('cache-control'), 'no-store');
      const body = (await created.json()) as { installation: { id: string }; signingSecret: string };
      assert.match(body.signingSecret, /^berry_whsec_/);
      installationId = body.installation.id;
      const again = await call('/installations', tokens.owner, {
         method: 'POST', body: JSON.stringify({ package: HELLO, config: { greeting: 'hi' } }),
      });
      assert.equal(again.status, 409);
   });

   test('config, secrets and tool approvals change; secret values never come back', async () => {
      const patched = await call(`/installations/${installationId}`, tokens.owner, {
         method: 'PATCH', body: JSON.stringify({ config: { greeting: 'yo' } }),
      });
      assert.equal(patched.status, 200);
      assert.equal((await call(`/installations/${installationId}/secrets/API_KEY`, tokens.owner, {
         method: 'PUT', body: JSON.stringify({ value: 'sk-secret-value' }),
      })).status, 204);
      const tool = await call(`/installations/${installationId}/tools/say_hello`, tokens.owner, {
         method: 'PUT', body: JSON.stringify({ approved: true }),
      });
      assert.equal(tool.status, 200);
      const detail = await call(`/installations/${installationId}`, tokens.member);
      const text = await detail.text();
      assert.ok(!text.includes('sk-secret-value'));
      const parsed = JSON.parse(text) as { secrets: { name: string; set: boolean }[]; mcpTools: { approved: boolean }[] };
      assert.deepEqual(parsed.secrets, [{ name: 'API_KEY', description: '', set: true }]);
      assert.equal(parsed.mcpTools[0]?.approved, true);
   });

   test('a member launches a surface and the launch is logged', async () => {
      const launched = await call(`/installations/${installationId}/surfaces/panel/launch`, tokens.member, { method: 'POST' });
      assert.equal(launched.status, 200);
      const body = (await launched.json()) as { url: string };
      assert.ok(body.url.startsWith('https://hello.example.com/ui#'));
      const fragment = new URLSearchParams(body.url.split('#')[1] ?? '');
      assert.match(fragment.get('token') ?? '', /^berry_plg_/);
      assert.equal(fragment.get('apiUrl'), 'https://berry.example.com');
      const log = (await (await call(`/installations/${installationId}/invocations`, tokens.owner)).json()) as {
         nodes: { kind: string }[];
      };
      assert.equal(log.nodes[0]?.kind, 'surface');
      assert.equal((await call(`/installations/${installationId}/surfaces/nope/launch`, tokens.member, { method: 'POST' })).status, 404);
   });

   test('a viewer\'s surface token carries no write scope, although the plugin was granted one', async () => {
      const launched = await call(`/installations/${installationId}/surfaces/panel/launch`, tokens.viewer, { method: 'POST' });
      assert.equal(launched.status, 200);
      const token = new URLSearchParams(((await launched.json()) as { url: string }).url.split('#')[1] ?? '').get('token') ?? '';
      const principal = await new PluginRuntimeStore({ sql }).resolveToken(token);
      // HELLO is granted issues:read and comments:write; a viewer may not write comments.
      assert.deepEqual(principal.scopes, ['issues:read']);
   });

   test('a viewer cannot change the plugin', async () => {
      const denied = await call(`/installations/${installationId}`, tokens.viewer, {
         method: 'PATCH', body: JSON.stringify({ enabled: false }),
      });
      assert.equal(denied.status, 403);
   });

   test('a member is told 404 for a plugin that is absent or another workspace\'s, and 403 only for this one', async () => {
      const other = await seedWorld(sql, 'admin');
      try {
         const token = (await new SecretsRepository(sql).createPersonalToken({
            userId: other.userId, name: 'x', expiresAt: null, idempotencyKey: randomUUID(),
            fingerprint: Buffer.alloc(32, randomUUID()), scopes: null,
         })).secret;
         const installed = await app.request(`/api/v1/plugins/${other.workspaceId}/installations`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ package: HELLO, config: { greeting: 'hi' } }),
         });
         assert.equal(installed.status, 201);
         const theirs = ((await installed.json()) as { installation: { id: string } }).installation.id;
         const probes: Array<[string, string, unknown]> = [
            ['PATCH', '', { enabled: false }],
            ['DELETE', '', undefined],
            ['PUT', '/secrets/API_KEY', { value: 'nope' }],
            ['DELETE', '/secrets/API_KEY', undefined],
            ['PUT', '/tools/say_hello', { approved: false }],
         ];
         for (const [method, suffix, body] of probes) {
            const probe = (id: string) =>
               call(`/installations/${id}${suffix}`, tokens.member, {
                  method,
                  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
               });
            assert.equal((await probe(theirs)).status, 404, `${method} ${suffix}: another workspace's plugin`);
            assert.equal((await probe(randomUUID())).status, 404, `${method} ${suffix}: no plugin at all`);
            assert.equal((await probe(installationId)).status, 403, `${method} ${suffix}: this workspace's plugin`);
         }
      } finally {
         await sql`DELETE FROM personal_api_tokens WHERE user_id = ${other.userId}`;
         await dropWorld(sql, other);
      }
   });

   test('uninstall removes it', async () => {
      assert.equal((await call(`/installations/${installationId}`, tokens.owner, { method: 'DELETE' })).status, 204);
      assert.equal((await call(`/installations/${installationId}`, tokens.owner)).status, 404);
   });
});
