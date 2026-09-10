import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { dropWorld, HELLO, seedWorld, testSealer, type World } from './fixture.test-support.ts';
import { parsePackage } from './manifest.ts';
import { pluginMcpServers } from './mcp.ts';
import { PluginRepository, type PluginInstallation } from './repository.ts';
import { PluginRuntimeStore } from './runtime-store.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('pluginMcpServers', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let world: World;
   let plugins: PluginRepository;
   let runtime: PluginRuntimeStore;
   let installation: PluginInstallation;

   before(async () => {
      sql = openDatabase({ url: url as string });
      world = await seedWorld(sql, 'mcp');
      plugins = new PluginRepository({ sql, sealer: testSealer() });
      runtime = new PluginRuntimeStore({ sql });
      installation = (await sql.begin((tx) =>
         plugins.install(tx, {
            workspaceId: world.workspaceId, installedBy: world.userId, pkg: parsePackage(HELLO),
            source: 'upload', sourceUrl: null, config: { greeting: 'hi' },
         })
      )).installation;
   });
   after(async () => {
      await dropWorld(sql, world);
      await closeDatabase(sql);
   });

   test('a plugin with no approved tools reaches no agent', async () => {
      assert.deepEqual(await pluginMcpServers({ plugins, runtime }, world.workspaceId, 60_000), []);
   });

   test('approved tools are exposed with a working plugin token', async () => {
      await sql.begin((tx) => plugins.setToolApproval(tx, world.workspaceId, installation.id, 'say_hello', true, world.userId));
      const [server] = await pluginMcpServers({ plugins, runtime }, world.workspaceId, 60_000);
      assert.ok(server);
      assert.equal(server.name, 'plugin-hello');
      assert.equal(server.url, 'https://hello.example.com/mcp');
      assert.deepEqual(server.allowedTools, ['say_hello']);
      const token = (server.headers.Authorization ?? '').replace(/^Bearer /, '');
      assert.equal((await runtime.resolveToken(token)).installationId, installation.id);
   });

   test('a disabled plugin reaches no agent', async () => {
      await sql.begin((tx) => plugins.update(tx, world.workspaceId, installation.id, { enabled: false }));
      assert.deepEqual(await pluginMcpServers({ plugins, runtime }, world.workspaceId, 60_000), []);
   });
});
