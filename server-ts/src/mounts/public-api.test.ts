import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { personalTokenResolver } from '../auth/credentials.ts';
import { CommentRepository } from '../core/comments.ts';
import { IssueRepository } from '../core/issues.ts';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { createApp, type BerryApp } from '../http/app.ts';
import { Registry } from '../http/registry.ts';
import { SecretsRepository } from '../identity/secrets.ts';
import { dropWorld, HELLO, seedWorld, testSealer, type World } from '../plugins/fixture.test-support.ts';
import { parsePackage } from '../plugins/manifest.ts';
import { PluginRepository } from '../plugins/repository.ts';
import { PluginRuntimeStore } from '../plugins/runtime-store.ts';
import { publicApiMounts } from './public-api.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('/v1 public API', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let app: BerryApp;
   let w1: World;
   let w2: World;
   let viewerId = '';
   const tokens = { full: '', readOnly: '', plugin: '', viewer: '' };

   before(async () => {
      sql = openDatabase({ url: url as string });
      const runtime = new PluginRuntimeStore({ sql });
      const registry = new Registry();
      registry.registerAll(
         publicApiMounts({
            personalTokens: personalTokenResolver(sql),
            sql,
            issues: new IssueRepository(sql),
            comments: new CommentRepository(sql),
            plugins: runtime,
         })
      );
      app = createApp(registry);
      w1 = await seedWorld(sql, 'v1-a');
      w2 = await seedWorld(sql, 'v1-b');

      const secrets = new SecretsRepository(sql);
      const make = async (key: string, scopes: ['issues:read'] | null) =>
         (await secrets.createPersonalToken({
            userId: w1.userId, name: key, expiresAt: null, idempotencyKey: key.repeat(16),
            fingerprint: Buffer.alloc(32, key), scopes,
         })).secret;
      tokens.full = await make('f', null);
      tokens.readOnly = await make('r', ['issues:read']);

      // A viewer of W1 with a full-access key: reads work, writes are refused by role.
      const [viewer] = await sql`
         INSERT INTO users (id, email, name) VALUES (${randomUUID()}, ${`v-${randomUUID()}@berry.test`}, 'V')
         RETURNING id`;
      viewerId = viewer?.id as string;
      await sql`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES (${w1.workspaceId}, ${viewerId}, 'viewer')`;
      tokens.viewer = (await secrets.createPersonalToken({
         userId: viewerId, name: 'v', expiresAt: null, idempotencyKey: 'v'.repeat(16),
         fingerprint: Buffer.alloc(32, 'v'), scopes: null,
      })).secret;

      const repo = new PluginRepository({ sql, sealer: testSealer() });
      const { installation } = await sql.begin((tx) =>
         repo.install(tx, {
            workspaceId: w1.workspaceId, installedBy: w1.userId,
            // HELLO is not granted storage. resolveToken intersects a token's
            // scopes with the install grant, so without this the storage test
            // would get INSUFFICIENT_SCOPE instead of exercising storage.
            pkg: parsePackage({
               ...HELLO,
               manifest: { ...HELLO.manifest, scopes: ['issues:read', 'comments:write', 'storage:read', 'storage:write'] },
            }),
            source: 'upload', sourceUrl: null, config: { greeting: 'hi' },
         })
      );
      tokens.plugin = (
         await runtime.mintToken({
            workspaceId: w1.workspaceId, installationId: installation.id,
            scopes: ['issues:read', 'comments:write', 'storage:read', 'storage:write'], ttlMs: 60_000,
         })
      ).token;
   });
   after(async () => {
      await sql`DELETE FROM personal_api_tokens WHERE user_id = ${viewerId}`;
      await sql`DELETE FROM workspace_memberships WHERE user_id = ${viewerId}`;
      await dropWorld(sql, w1);
      await dropWorld(sql, w2);
      await sql`DELETE FROM users WHERE id = ${viewerId}`;
      await closeDatabase(sql);
   });

   const call = (path: string, token: string, init: RequestInit = {}) =>
      app.request(path, {
         ...init,
         headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
      });

   test('a viewer reads but cannot write issues or comments, whatever the key scopes', async () => {
      assert.equal((await call(`/v1/issues/${w1.identifier}`, tokens.viewer)).status, 200);
      const patch = await call(`/v1/issues/${w1.identifier}`, tokens.viewer, {
         method: 'PATCH', body: JSON.stringify({ title: 'Nope' }),
      });
      assert.equal(patch.status, 403);
      const comment = await call(`/v1/issues/${w1.identifier}/comments`, tokens.viewer, {
         method: 'POST', body: JSON.stringify({ body: 'Nope' }),
      });
      assert.equal(comment.status, 403);
   });
   const code = async (response: Response) =>
      ((await response.json()) as { error: { code: string } }).error.code;

   test('context names the caller and their workspaces', async () => {
      const response = await call('/v1/context', tokens.full);
      assert.equal(response.status, 200);
      const body = (await response.json()) as { principal: { type: string }; scopes: unknown; workspaces: { id: string }[] };
      assert.equal(body.principal.type, 'user');
      assert.equal(body.scopes, null);
      assert.deepEqual(body.workspaces.map((w) => w.id), [w1.workspaceId]);
   });

   test('an issue reads by identifier; another tenant reads as missing', async () => {
      const own = await call(`/v1/issues/${w1.identifier}`, tokens.readOnly);
      assert.equal(own.status, 200);
      assert.equal(((await own.json()) as { identifier: string }).identifier, w1.identifier);
      const foreign = await call(`/v1/issues/${w2.identifier}`, tokens.full);
      assert.equal(foreign.status, 404);
      const random = await call('/v1/issues/ZZZZ-999999', tokens.full);
      assert.equal(random.status, 404);
   });

   test('writing needs the write scope', async () => {
      const denied = await call(`/v1/issues/${w1.identifier}`, tokens.readOnly, {
         method: 'PATCH', body: JSON.stringify({ title: 'Renamed' }),
      });
      assert.equal(denied.status, 403);
      assert.equal(await code(denied), 'INSUFFICIENT_SCOPE');
      const allowed = await call(`/v1/issues/${w1.identifier}`, tokens.full, {
         method: 'PATCH', body: JSON.stringify({ title: 'Renamed', priority: 'high' }),
      });
      assert.equal(allowed.status, 200);
      const body = (await allowed.json()) as { title: string; priority: string };
      assert.equal(body.title, 'Renamed');
      assert.equal(body.priority, 'high');
      const invalid = await call(`/v1/issues/${w1.identifier}`, tokens.full, {
         method: 'PATCH', body: JSON.stringify({ status: 'nope' }),
      });
      assert.equal(invalid.status, 422);
   });

   test('comments are created and listed', async () => {
      const created = await call(`/v1/issues/${w1.identifier}/comments`, tokens.full, {
         method: 'POST', body: JSON.stringify({ body: 'From the API.' }),
      });
      assert.equal(created.status, 201);
      const listed = await call(`/v1/issues/${w1.identifier}/comments`, tokens.full);
      const nodes = ((await listed.json()) as { nodes: { body: string }[] }).nodes;
      assert.ok(nodes.some((n) => n.body === 'From the API.'));
   });

   test('a session-shaped or missing credential is 401', async () => {
      assert.equal((await app.request('/v1/context')).status, 401);
      assert.equal((await call('/v1/context', Buffer.alloc(32, 1).toString('base64url'))).status, 401);
   });

   test('a plugin token sees only its own workspace and its granted scopes', async () => {
      assert.equal((await call(`/v1/issues/${w1.identifier}`, tokens.plugin)).status, 200);
      assert.equal((await call(`/v1/issues/${w2.identifier}`, tokens.plugin)).status, 404);
      const patch = await call(`/v1/issues/${w1.identifier}`, tokens.plugin, {
         method: 'PATCH', body: JSON.stringify({ title: 'x' }),
      });
      assert.equal(await code(patch), 'INSUFFICIENT_SCOPE');
      const context = (await (await call('/v1/context', tokens.plugin)).json()) as { principal: { type: string } };
      assert.equal(context.principal.type, 'plugin');
   });

   test('storage is plugin-only and round-trips values', async () => {
      assert.equal(await code(await call('/v1/storage', tokens.full)), 'PLUGIN_TOKEN_REQUIRED');
      const put = await call('/v1/storage/sync/cursor', tokens.plugin, {
         method: 'PUT', body: JSON.stringify({ value: { at: 3 } }),
      });
      assert.equal(put.status, 200);
      const got = await call('/v1/storage/sync/cursor', tokens.plugin);
      assert.deepEqual(((await got.json()) as { value: unknown }).value, { at: 3 });
      const listed = await call('/v1/storage?prefix=sync/', tokens.plugin);
      assert.deepEqual(((await listed.json()) as { nodes: { key: string }[] }).nodes.map((n) => n.key), ['sync/cursor']);
      assert.equal((await call('/v1/storage/sync/cursor', tokens.plugin, { method: 'DELETE' })).status, 204);
      assert.equal((await call('/v1/storage/sync/cursor', tokens.plugin)).status, 404);
   });
});
