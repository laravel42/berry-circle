import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { NotFound } from '../identity/errors.ts';
import { InvalidPluginInput, PluginAlreadyInstalled } from './errors.ts';
import { dropWorld, HELLO, seedWorld, testSealer, type World } from './fixture.test-support.ts';
import { parsePackage } from './manifest.ts';
import { PluginRepository } from './repository.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('PluginRepository', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let repo: PluginRepository;
   let world: World;
   let other: World;

   before(async () => {
      sql = openDatabase({ url: url as string });
      repo = new PluginRepository({ sql, sealer: testSealer() });
      world = await seedWorld(sql, 'plug-a');
      other = await seedWorld(sql, 'plug-b');
   });
   after(async () => {
      await dropWorld(sql, world);
      await dropWorld(sql, other);
      await closeDatabase(sql);
   });

   const install = (workspace: World) =>
      sql.begin((tx) =>
         repo.install(tx, {
            workspaceId: workspace.workspaceId,
            installedBy: workspace.userId,
            pkg: parsePackage(HELLO),
            source: 'upload',
            sourceUrl: null,
            config: { greeting: 'hi' },
         })
      );

   test('an install stores the manifest, grants its scopes and returns the signing secret once', async () => {
      const { installation, signingSecret } = await install(world);
      assert.match(signingSecret, /^berry_whsec_/);
      assert.equal(installation.key, 'hello');
      assert.equal(installation.enabled, true);
      assert.deepEqual(installation.config, { greeting: 'hi' });
      assert.deepEqual(installation.grantedScopes, ['issues:read', 'comments:write']);
      assert.equal(await repo.signingSecret(world.workspaceId, installation.id), signingSecret);

      const [stored] = await sql`
         SELECT signing_secret_encrypted FROM plugin_installations WHERE id = ${installation.id}`;
      assert.ok(!Buffer.from(stored?.signing_secret_encrypted as Buffer).toString('utf8').includes(signingSecret));

      const events = await sql`
         SELECT topic FROM outbox_events WHERE aggregate_id = ${installation.id}`;
      assert.deepEqual(events.map((e) => e.topic), ['plugin.installed']);

      const hooks = await sql`SELECT hook_key FROM plugin_hook_state WHERE installation_id = ${installation.id}`;
      assert.deepEqual(hooks.map((h) => h.hook_key), ['nightly']);
      assert.deepEqual(await repo.files(world.workspaceId, installation.id), [{ path: 'README.md', size: 7 }]);
   });

   test('installing the same key twice in one workspace is a conflict', async () => {
      await assert.rejects(install(world), PluginAlreadyInstalled);
   });

   test('another workspace cannot read, change or remove the installation', async () => {
      const [found] = await repo.list(world.workspaceId);
      assert.ok(found);
      await assert.rejects(repo.get(other.workspaceId, found.id), NotFound);
      await assert.rejects(sql.begin((tx) => repo.update(tx, other.workspaceId, found.id, { enabled: false })), NotFound);
      await assert.rejects(sql.begin((tx) => repo.uninstall(tx, other.workspaceId, found.id)), NotFound);
      assert.deepEqual(await repo.list(other.workspaceId), []);
   });

   test('config updates are validated and enable toggles', async () => {
      const [found] = await repo.list(world.workspaceId);
      assert.ok(found);
      await assert.rejects(
         sql.begin((tx) => repo.update(tx, world.workspaceId, found.id, { config: { greeting: 3 } })),
         InvalidPluginInput
      );
      const updated = await sql.begin((tx) =>
         repo.update(tx, world.workspaceId, found.id, { enabled: false, config: { greeting: 'hey' } })
      );
      assert.equal(updated.enabled, false);
      assert.deepEqual(updated.config, { greeting: 'hey' });
      assert.deepEqual(await repo.listEnabled(world.workspaceId), []);
   });

   test('only declared secrets are stored, sealed, and opened for the caller', async () => {
      const [found] = await repo.list(world.workspaceId);
      assert.ok(found);
      await assert.rejects(
         sql.begin((tx) => repo.setSecret(tx, world.workspaceId, found.id, 'OTHER', 'x')),
         InvalidPluginInput
      );
      await sql.begin((tx) => repo.setSecret(tx, world.workspaceId, found.id, 'API_KEY', 'sk-123'));
      const [row] = await sql`SELECT value_encrypted FROM plugin_secrets WHERE installation_id = ${found.id}`;
      assert.ok(!Buffer.from(row?.value_encrypted as Buffer).toString('utf8').includes('sk-123'));
      assert.deepEqual(await repo.openSecrets(world.workspaceId, found.id), { API_KEY: 'sk-123' });
      assert.deepEqual((await repo.get(world.workspaceId, found.id)).secretNames, ['API_KEY']);
      await sql.begin((tx) => repo.deleteSecret(tx, world.workspaceId, found.id, 'API_KEY'));
      assert.deepEqual(await repo.openSecrets(world.workspaceId, found.id), {});
   });

   test('only declared MCP tools can be approved', async () => {
      const [found] = await repo.list(world.workspaceId);
      assert.ok(found);
      await assert.rejects(
         sql.begin((tx) => repo.setToolApproval(tx, world.workspaceId, found.id, 'rm_rf', true, world.userId)),
         InvalidPluginInput
      );
      await sql.begin((tx) => repo.setToolApproval(tx, world.workspaceId, found.id, 'say_hello', true, world.userId));
      assert.deepEqual((await repo.get(world.workspaceId, found.id)).approvedTools, ['say_hello']);
      await sql.begin((tx) => repo.setToolApproval(tx, world.workspaceId, found.id, 'say_hello', false, world.userId));
      assert.deepEqual((await repo.get(world.workspaceId, found.id)).approvedTools, []);
   });

   test('uninstall removes the installation and everything under it', async () => {
      const [found] = await repo.list(world.workspaceId);
      assert.ok(found);
      await sql.begin((tx) => repo.uninstall(tx, world.workspaceId, found.id));
      assert.deepEqual(await repo.list(world.workspaceId), []);
      const files = await sql`SELECT 1 FROM plugin_files WHERE installation_id = ${found.id}`;
      assert.equal(files.length, 0);
   });
});
