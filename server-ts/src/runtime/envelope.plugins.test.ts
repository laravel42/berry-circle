import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { nullRunMemory } from '../agentcore/memory.ts';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { GitHubClient } from '../integrations/github.ts';
import { HELLO, testSealer } from '../plugins/fixture.test-support.ts';
import { parsePackage } from '../plugins/manifest.ts';
import { PluginRepository, type PluginInstallation } from '../plugins/repository.ts';
import { PluginRuntimeStore } from '../plugins/runtime-store.ts';
import { enqueueTask } from '../runs/queue.ts';
import { redactEnvelope, taskEnvelopeSchema, type TaskEnvelope } from './envelope.ts';
import { EnvelopeBuilder, loadTask } from './envelope-builder.ts';
import { cleanupFixture, createIssue, seedFixture, type Fixture } from './test-fixture.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

/** One server, two declared tools: only one of them gets approved. */
const RELAY = {
   manifest: {
      ...HELLO.manifest,
      key: 'relay',
      name: 'Relay',
      baseUrl: 'https://relay.example.com/',
      mcp: { path: '/mcp', tools: [{ name: 'say_hello' }, { name: 'delete_everything' }] },
   },
   files: HELLO.files,
};
const FOREIGN = {
   manifest: { ...HELLO.manifest, key: 'foreign', name: 'Foreign', baseUrl: 'https://foreign.example.com' },
   files: HELLO.files,
};

describe('the envelope carries approved plugin MCP tools', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let mine: Fixture | null = null;
   let theirs: Fixture | null = null;
   let plugins: PluginRepository;
   let runtime: PluginRuntimeStore;
   let builder: EnvelopeBuilder;
   let relay: PluginInstallation;

   async function install(fixture: Fixture, pkg: typeof RELAY, approve: string[]): Promise<PluginInstallation> {
      return sql.begin(async (tx) => {
         const { installation } = await plugins.install(tx, {
            workspaceId: fixture.workspaceId, installedBy: fixture.userId, pkg: parsePackage(pkg),
            source: 'upload', sourceUrl: null, config: { greeting: 'hi' },
         });
         for (const tool of approve) {
            await plugins.setToolApproval(tx, fixture.workspaceId, installation.id, tool, true, fixture.userId);
         }
         return installation;
      });
   }

   async function agentEnvelope(fixture: Fixture): Promise<TaskEnvelope> {
      const issueId = await createIssue(sql, fixture, 'Plugin task');
      const { runId } = await enqueueTask(sql, {
         workspaceId: fixture.workspaceId, agentId: fixture.agentId, issueId, kind: 'agent', source: 'mention', prompt: 'go',
      });
      const { envelope } = await builder.build({ task: await loadTask(sql, runId), dispatch: null, token: 'berry_task_x' });
      return taskEnvelopeSchema.parse(envelope);
   }

   const tokenCount = async (installationId: string): Promise<number> =>
      Number((await sql`SELECT count(*) AS n FROM plugin_tokens WHERE installation_id = ${installationId}`)[0]?.n);

   before(async () => {
      sql = openDatabase({ url: url! });
      mine = await seedFixture(sql, 'plugin-envelope');
      theirs = await seedFixture(sql, 'plugin-envelope-other');
      plugins = new PluginRepository({ sql, sealer: testSealer() });
      runtime = new PluginRuntimeStore({ sql });
      builder = new EnvelopeBuilder({
         sql,
         publicUrl: 'https://berry.test',
         defaultModel: 'default-model',
         memory: nullRunMemory(),
         sealer: null,
         github: (token) => new GitHubClient({ token }),
         plugins: { plugins, runtime, ttlMs: 60_000 },
      });
      relay = await install(mine, RELAY, ['say_hello']);
      await install(theirs, FOREIGN, ['say_hello']);
   });
   after(async () => {
      for (const fixture of [mine, theirs]) {
         if (fixture) await sql`DELETE FROM plugin_installations WHERE workspace_id = ${fixture.workspaceId}`;
         await cleanupFixture(sql, fixture);
      }
      await closeDatabase(sql);
   });

   test('an approved tool is exposed, and an unapproved tool on the same server is not', async () => {
      const envelope = await agentEnvelope(mine!);
      const server = envelope.agent.mcpServers.find((candidate) => candidate.name === 'plugin-relay');
      assert.ok(server, 'the approved plugin server is in the envelope');
      assert.equal(server.url, 'https://relay.example.com/mcp');
      assert.equal(server.transport, 'streamable_http');
      assert.deepEqual(server.allowedTools, ['say_hello']);
      // The token was minted for this build, for this installation, and works.
      const token = (server.headers.Authorization ?? '').replace(/^Bearer /, '');
      assert.equal((await runtime.resolveToken(token)).installationId, relay.id);
   });

   test('another workspace’s plugin never appears', async () => {
      const envelope = await agentEnvelope(mine!);
      assert.deepEqual(envelope.agent.mcpServers.map((server) => server.name), ['plugin-relay']);
      assert.ok(!JSON.stringify(envelope.agent.mcpServers).includes('foreign.example.com'));
      // And the other way round: their agent sees theirs, never mine.
      const other = await agentEnvelope(theirs!);
      assert.deepEqual(other.agent.mcpServers.map((server) => server.name), ['plugin-foreign']);
   });

   test('the plugin token is a secret: redacted from logs, and never minted for a completion', async () => {
      const envelope = await agentEnvelope(mine!);
      const logged = JSON.stringify(redactEnvelope(envelope));
      const token = envelope.agent.mcpServers[0]?.headers.Authorization ?? '';
      assert.ok(token.startsWith('Bearer '));
      assert.ok(!logged.includes(token.slice('Bearer '.length)), 'the logged envelope does not carry the token');

      const before = await tokenCount(relay.id);
      const { runId } = await enqueueTask(sql, {
         workspaceId: mine!.workspaceId, agentId: mine!.orchestratorId, kind: 'completion', source: 'completion', prompt: 'p',
      });
      const { envelope: completion } = await builder.build({ task: await loadTask(sql, runId), dispatch: null, token: 'berry_task_x' });
      assert.deepEqual(completion.agent.mcpServers, []);
      assert.equal(await tokenCount(relay.id), before, 'a completion mints no plugin token');
   });

   test('a disabled plugin contributes nothing', async () => {
      await sql.begin((tx) => plugins.update(tx, mine!.workspaceId, relay.id, { enabled: false }));
      const before = await tokenCount(relay.id);
      const envelope = await agentEnvelope(mine!);
      assert.deepEqual(envelope.agent.mcpServers, []);
      assert.equal(await tokenCount(relay.id), before, 'a disabled plugin gets no token');
   });
});
