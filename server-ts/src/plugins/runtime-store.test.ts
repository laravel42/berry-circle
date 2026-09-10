import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { InvalidPluginInput } from './errors.ts';
import { dropWorld, HELLO, seedWorld, testSealer, type World } from './fixture.test-support.ts';
import { parsePackage } from './manifest.ts';
import { PluginRepository, type PluginInstallation } from './repository.ts';
import { PluginRuntimeStore, PluginTokenInvalid, validStorageKey } from './runtime-store.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('PluginRuntimeStore', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let store: PluginRuntimeStore;
   let repo: PluginRepository;
   let world: World;
   let installation: PluginInstallation;

   before(async () => {
      sql = openDatabase({ url: url as string });
      store = new PluginRuntimeStore({ sql });
      repo = new PluginRepository({ sql, sealer: testSealer() });
      world = await seedWorld(sql, 'runtime');
      installation = (
         await sql.begin((tx) =>
            repo.install(tx, {
               workspaceId: world.workspaceId,
               installedBy: world.userId,
               pkg: parsePackage(HELLO),
               source: 'upload',
               sourceUrl: null,
               config: { greeting: 'hi' },
            })
         )
      ).installation;
   });
   after(async () => {
      await dropWorld(sql, world);
      await closeDatabase(sql);
   });

   test('a minted token resolves to its installation, scopes limited to what was granted', async () => {
      const { token } = await store.mintToken({
         workspaceId: world.workspaceId,
         installationId: installation.id,
         scopes: ['issues:read', 'issues:write'],
         ttlMs: 60_000,
      });
      const principal = await store.resolveToken(token);
      assert.equal(principal.installationId, installation.id);
      assert.equal(principal.workspaceId, world.workspaceId);
      assert.equal(principal.installedBy, world.userId);
      // issues:write was never granted at install, so the token cannot carry it.
      assert.deepEqual(principal.scopes, ['issues:read']);
   });

   test('expired, tampered and disabled-plugin tokens are refused', async () => {
      const expired = await store.mintToken({
         workspaceId: world.workspaceId, installationId: installation.id, scopes: ['issues:read'], ttlMs: -1000,
      });
      await assert.rejects(store.resolveToken(expired.token), PluginTokenInvalid);

      const good = await store.mintToken({
         workspaceId: world.workspaceId, installationId: installation.id, scopes: ['issues:read'], ttlMs: 60_000,
      });
      const tampered = good.token.slice(0, -2) + (good.token.endsWith('AA') ? 'BB' : 'AA');
      await assert.rejects(store.resolveToken(tampered), PluginTokenInvalid);
      await assert.rejects(store.resolveToken('berry_plg_nope'), PluginTokenInvalid);

      await sql.begin((tx) => repo.update(tx, world.workspaceId, installation.id, { enabled: false }));
      await assert.rejects(store.resolveToken(good.token), PluginTokenInvalid);
      await sql.begin((tx) => repo.update(tx, world.workspaceId, installation.id, { enabled: true }));
      assert.ok(await store.pruneTokens() >= 1);
   });

   test('storage round-trips JSON values and lists by prefix in key order', async () => {
      const owner = { installationId: installation.id, workspaceId: world.workspaceId };
      await store.putValue(owner, 'sync/b', { n: 2 });
      await store.putValue(owner, 'sync/a', { n: 1 });
      await store.putValue(owner, 'other', true);
      assert.deepEqual((await store.getValue(installation.id, 'sync/a'))?.value, { n: 1 });
      const listed = await store.listValues(installation.id, { prefix: 'sync/', after: null, limit: 10 });
      assert.deepEqual(listed.map((v) => v.key), ['sync/a', 'sync/b']);
      const page = await store.listValues(installation.id, { prefix: 'sync/', after: 'sync/a', limit: 10 });
      assert.deepEqual(page.map((v) => v.key), ['sync/b']);
      assert.equal(await store.deleteValue(installation.id, 'sync/a'), true);
      assert.equal(await store.getValue(installation.id, 'sync/a'), null);
      assert.equal(await store.deleteValue(installation.id, 'sync/a'), false);
   });

   test('storage refuses bad keys and oversized values', async () => {
      const owner = { installationId: installation.id, workspaceId: world.workspaceId };
      assert.equal(validStorageKey('a b'), false);
      assert.equal(validStorageKey('a'.repeat(201)), false);
      await assert.rejects(store.putValue(owner, 'big', 'x'.repeat(70_000)), InvalidPluginInput);
   });

   test('invocations list newest first with a cursor', async () => {
      // A clock one second apart per call, so the (created_at, id) order never
      // falls back to comparing random uuids.
      const base = Date.now() + 60_000;
      let tick = 0;
      const timed = new PluginRuntimeStore({ sql, clock: () => new Date(base + tick++ * 1000) });
      for (const trigger of ['one', 'two', 'three']) {
         await timed.recordInvocation({
            workspaceId: world.workspaceId, installationId: installation.id, kind: 'event',
            trigger, status: 'ok', httpStatus: 200, durationMs: 5, error: null,
         });
      }
      const first = await store.listInvocations(world.workspaceId, installation.id, null, 2);
      assert.deepEqual(first.map((i) => i.trigger), ['three', 'two']);
      const last = first.at(-1);
      assert.ok(last);
      const next = await store.listInvocations(world.workspaceId, installation.id, { createdAt: last.createdAt, id: last.id }, 2);
      assert.deepEqual(next.map((i) => i.trigger), ['one']);
   });

   test('another installation cannot read or delete this one\'s storage', async () => {
      const owner = { installationId: installation.id, workspaceId: world.workspaceId };
      await store.putValue(owner, 'mine', 1);
      const stranger = '00000000-0000-4000-8000-000000000001';
      assert.equal(await store.getValue(stranger, 'mine'), null);
      assert.equal(await store.deleteValue(stranger, 'mine'), false);
      assert.equal((await store.getValue(installation.id, 'mine'))?.value, 1);
   });
});
