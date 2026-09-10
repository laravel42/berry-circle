// Cross-tenant leakage for the plugin admin mount and the public API, in the
// shape of cross-tenant-leakage.test.ts: U1 owns W1, W2 belongs to someone
// else and has a plugin installed. Nothing of W2 is readable or writable by U1.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { personalTokenResolver } from '../auth/credentials.ts';
import { CommentRepository } from '../core/comments.ts';
import { IssueRepository } from '../core/issues.ts';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { createApp, type BerryApp } from '../http/app.ts';
import { Registry } from '../http/registry.ts';
import { SecretsRepository } from '../identity/secrets.ts';
import { dropWorld, HELLO, seedWorld, testSealer, testSessions, type World } from '../plugins/fixture.test-support.ts';
import { parsePackage } from '../plugins/manifest.ts';
import { PluginRepository } from '../plugins/repository.ts';
import { PluginRuntimeStore } from '../plugins/runtime-store.ts';
import { pluginMounts } from './plugins.ts';
import { publicApiMounts } from './public-api.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;
const REQUEST_ID = 'req_' + 'b'.repeat(32);

describe('Feature: plugins, cross-tenant leakage', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let app: BerryApp;
   let w1: World;
   let w2: World;
   let u1Token = '';
   let w2Installation = '';
   let w2PluginToken = '';
   let plugins: PluginRepository;

   before(async () => {
      sql = openDatabase({ url: url as string });
      const sessions = testSessions(sql);
      plugins = new PluginRepository({ sql, sealer: testSealer() });
      const runtime = new PluginRuntimeStore({ sql });
      const registry = new Registry();
      registry.registerAll(
         pluginMounts({ sessions, sql, plugins, runtime, network: { request: async () => ({ status: 500, body: '' }) }, publicUrl: null })
      );
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
      w1 = await seedWorld(sql, 'leak-p1');
      w2 = await seedWorld(sql, 'leak-p2');
      u1Token = (await new SecretsRepository(sql).createPersonalToken({
         userId: w1.userId, name: 'u1', expiresAt: null, idempotencyKey: 'u'.repeat(20), fingerprint: Buffer.alloc(32, 'u'), scopes: null,
      })).secret;
      const { installation } = await sql.begin((tx) =>
         plugins.install(tx, {
            workspaceId: w2.workspaceId, installedBy: w2.userId, pkg: parsePackage(HELLO),
            source: 'upload', sourceUrl: null, config: { greeting: 'hi' },
         })
      );
      w2Installation = installation.id;
      w2PluginToken = (await runtime.mintToken({
         workspaceId: w2.workspaceId, installationId: installation.id, scopes: ['issues:read'], ttlMs: 60_000,
      })).token;
   });
   after(async () => {
      await dropWorld(sql, w1);
      await dropWorld(sql, w2);
      await closeDatabase(sql);
   });

   const as = (path: string, token: string | null, method = 'GET', body?: unknown) =>
      app.request(path, {
         method,
         headers: {
            'x-request-id': REQUEST_ID,
            'content-type': 'application/json',
            ...(token ? { authorization: `Bearer ${token}` } : {}),
         },
         ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

   test('(a) U1 listing W1 never sees the W2 installation', async () => {
      const body = (await (await as(`/api/v1/plugins/${w1.workspaceId}/installations`, u1Token)).json()) as { nodes: { id: string }[] };
      assert.ok(!body.nodes.some((n) => n.id === w2Installation));
   });

   test('(b) a W2 path answers as a missing workspace, and a W2 id under W1 as a missing plugin', async () => {
      for (const path of [
         `/api/v1/plugins/${w2.workspaceId}/installations`,
         `/api/v1/plugins/${w2.workspaceId}/installations/${w2Installation}`,
         `/api/v1/plugins/${w1.workspaceId}/installations/${w2Installation}`,
         `/api/v1/plugins/${w1.workspaceId}/installations/${w2Installation}/storage`,
         `/api/v1/plugins/${w1.workspaceId}/installations/${w2Installation}/invocations`,
      ]) {
         assert.equal((await as(path, u1Token)).status, 404, path);
      }
      assert.equal((await as(`/api/v1/plugins/${w2.workspaceId}/preview`, u1Token, 'POST', { package: HELLO })).status, 404);
   });

   test('(c) U1 mutating the W2 installation gets 404 and W2 is unchanged', async () => {
      await sql.begin((tx) => plugins.setSecret(tx, w2.workspaceId, w2Installation, 'API_KEY', 'w2-secret'));
      for (const [path, method, body] of [
         [`/api/v1/plugins/${w1.workspaceId}/installations/${w2Installation}`, 'PATCH', { enabled: false }],
         [`/api/v1/plugins/${w1.workspaceId}/installations/${w2Installation}`, 'DELETE', undefined],
         [`/api/v1/plugins/${w1.workspaceId}/installations/${w2Installation}/secrets/API_KEY`, 'PUT', { value: 'x' }],
         [`/api/v1/plugins/${w1.workspaceId}/installations/${w2Installation}/secrets/API_KEY`, 'DELETE', undefined],
         [`/api/v1/plugins/${w1.workspaceId}/installations/${w2Installation}/tools/say_hello`, 'PUT', { approved: true }],
         [`/api/v1/plugins/${w1.workspaceId}/installations/${w2Installation}/surfaces/panel/launch`, 'POST', undefined],
         [`/api/v1/plugins/${w2.workspaceId}/installations/${w2Installation}`, 'PATCH', { enabled: false }],
         [`/api/v1/plugins/${w2.workspaceId}/installations`, 'POST', { package: HELLO, config: { greeting: 'x' } }],
      ] as const) {
         assert.equal((await as(path, u1Token, method, body)).status, 404, `${method} ${path}`);
      }
      const [row] = await sql`SELECT enabled FROM plugin_installations WHERE id = ${w2Installation}`;
      assert.equal(row?.enabled, true);
      assert.deepEqual(await plugins.openSecrets(w2.workspaceId, w2Installation), { API_KEY: 'w2-secret' });
      const approvals = await sql`SELECT 1 FROM plugin_tool_approvals WHERE installation_id = ${w2Installation}`;
      assert.equal(approvals.length, 0);
      const tokens = await sql`SELECT 1 FROM plugin_tokens WHERE installation_id = ${w2Installation}`;
      assert.equal(tokens.length, 1, 'only the token minted in before()');
   });

   test("(c'') a W2 plugin token sees only W2 in context", async () => {
      const context = (await (await as('/v1/context', w2PluginToken)).json()) as { workspaces: { id: string }[] };
      assert.deepEqual(context.workspaces.map((w) => w.id), [w2.workspaceId]);
   });

   test("(c') a W2 plugin token cannot read a W1 issue", async () => {
      assert.equal((await as(`/v1/issues/${w1.identifier}`, w2PluginToken)).status, 404);
   });

   test('(d) no credential is 401 on both mounts', async () => {
      assert.equal((await as(`/api/v1/plugins/${w1.workspaceId}/installations`, null)).status, 401);
      assert.equal((await as('/v1/context', null)).status, 401);
   });

   test('(e) U1 cannot read or write a W2 issue through /v1, and W2 is unchanged', async () => {
      const [before] = await sql`SELECT title FROM issues WHERE id = ${w2.issueId}`;
      assert.equal((await as(`/v1/issues/${w2.issueId}`, u1Token)).status, 404);
      assert.equal((await as(`/v1/issues/${w2.identifier}`, u1Token, 'PATCH', { title: 'Leaked' })).status, 404);
      assert.equal((await as(`/v1/issues/${w2.identifier}/comments`, u1Token)).status, 404);
      assert.equal((await as(`/v1/issues/${w2.identifier}/comments`, u1Token, 'POST', { body: 'Leaked' })).status, 404);
      const [after] = await sql`SELECT title FROM issues WHERE id = ${w2.issueId}`;
      assert.equal(after?.title, before?.title);
      const comments = await sql`SELECT 1 FROM comments WHERE issue_id = ${w2.issueId}`;
      assert.equal(comments.length, 0);
   });
});
