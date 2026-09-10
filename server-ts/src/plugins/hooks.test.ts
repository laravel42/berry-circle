import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { dropWorld, HELLO, seedWorld, testSealer, type World } from './fixture.test-support.ts';
import { PluginCaller, PluginHookRunner } from './hooks.ts';
import { parsePackage } from './manifest.ts';
import type { PluginNetwork, PluginRequest } from './net.ts';
import { PluginRepository, type PluginInstallation } from './repository.ts';
import { PluginRuntimeStore } from './runtime-store.ts';
import { SIGNATURE_HEADER, signPayload } from './signing.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('plugin hooks', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let world: World;
   let repo: PluginRepository;
   let runtime: PluginRuntimeStore;
   let installation: PluginInstallation;
   let signingSecret = '';
   let failPaths = new Set<string>();
   // A base URL unique to this run, so deliveries to other tests' plugins are ignored.
   const baseUrl = `https://hooks-${randomUUID().slice(0, 8)}.example.com`;
   const calls: { url: string; init: PluginRequest }[] = [];
   const network: PluginNetwork = {
      request: async (target, init) => {
         calls.push({ url: target, init });
         const path = new URL(target).pathname;
         return { status: failPaths.has(path) ? 500 : 200, body: '{}' };
      },
   };
   const ours = () => calls.filter((c) => c.url.startsWith(baseUrl));

   before(async () => {
      sql = openDatabase({ url: url as string });
      world = await seedWorld(sql, 'hooks');
      repo = new PluginRepository({ sql, sealer: testSealer() });
      runtime = new PluginRuntimeStore({ sql });
      const pkg = parsePackage({ ...HELLO, manifest: { ...HELLO.manifest, baseUrl } });
      const installed = await sql.begin((tx) =>
         repo.install(tx, {
            workspaceId: world.workspaceId, installedBy: world.userId, pkg,
            source: 'upload', sourceUrl: null, config: { greeting: 'hi' },
         })
      );
      installation = installed.installation;
      signingSecret = installed.signingSecret;
      await sql.begin((tx) => repo.setSecret(tx, world.workspaceId, installation.id, 'API_KEY', 'sk-1'));
      await sql`INSERT INTO plugin_event_cursor (id) VALUES (1) ON CONFLICT DO NOTHING`;
      // Just before the test's own events, so one batch reaches them even when
      // other suites have written outbox rows recently.
      await sql`UPDATE plugin_event_cursor SET occurred_at = now() - interval '11 seconds', event_id = '00000000-0000-0000-0000-000000000000' WHERE id = 1`;
   });
   after(async () => {
      await dropWorld(sql, world);
      await closeDatabase(sql);
   });

   const runner = () =>
      new PluginHookRunner({
         sql,
         plugins: repo,
         caller: new PluginCaller({ plugins: repo, runtime, network, publicUrl: 'https://berry.example.com' }),
      });

   test('an outbox event matching a hook is delivered once, signed, with config, secrets and a token', async () => {
      const eventId = randomUUID();
      await sql`
         INSERT INTO outbox_events (id, topic, aggregate_type, aggregate_id, workspace_id, payload, occurred_at, available_at)
         VALUES (${eventId}, 'comment.created', 'comment', ${randomUUID()}, ${world.workspaceId},
                 ${sql.json({ id: eventId, type: 'comment.created', payload: { comment: { body: 'hi' } } } as never)},
                 now() - interval '10 seconds', now() - interval '10 seconds')`;
      await runner().tick();
      await runner().tick();
      const delivered = ours().filter((c) => c.url === `${baseUrl}/hooks/comment`);
      assert.equal(delivered.length, 1);
      const call = delivered[0];
      assert.ok(call);
      const body = call.init.body ?? '';
      const header = call.init.headers?.[SIGNATURE_HEADER] ?? '';
      const timestamp = Number(/t=(\d+)/.exec(header)?.[1]);
      assert.equal(header, signPayload(signingSecret, timestamp, body));
      const parsed = JSON.parse(body) as {
         type: string; trigger: string; config: unknown; secrets: unknown; api: { token: string; url: string };
         event: { id: string; payload: unknown };
      };
      // HELLO is not granted comments:read, so the comment body is withheld.
      assert.equal(parsed.event.payload, null);
      assert.equal(parsed.type, 'event');
      assert.equal(parsed.trigger, 'comment.created');
      assert.deepEqual(parsed.config, { greeting: 'hi' });
      assert.deepEqual(parsed.secrets, { API_KEY: 'sk-1' });
      assert.match(parsed.api.token, /^berry_plg_/);
      assert.equal(parsed.api.url, 'https://berry.example.com');
      assert.equal(parsed.event.id, eventId);
      const logged = await runtime.listInvocations(world.workspaceId, installation.id, null, 10);
      assert.equal(logged[0]?.kind, 'event');
      assert.equal(logged[0]?.status, 'ok');
   });

   test('a due schedule fires once and moves its next time forward; failures are logged as errors', async () => {
      failPaths = new Set(['/hooks/nightly']);
      await sql`UPDATE plugin_hook_state SET next_fire_at = now() - interval '1 second' WHERE installation_id = ${installation.id}`;
      await runner().tick();
      await runner().tick();
      assert.equal(ours().filter((c) => c.url === `${baseUrl}/hooks/nightly`).length, 1);
      const [state] = await sql`SELECT next_fire_at > now() AS ahead FROM plugin_hook_state WHERE installation_id = ${installation.id}`;
      assert.equal(state?.ahead, true);
      const logged = await runtime.listInvocations(world.workspaceId, installation.id, null, 1);
      assert.equal(logged[0]?.kind, 'schedule');
      assert.equal(logged[0]?.status, 'error');
      assert.equal(logged[0]?.httpStatus, 500);
   });

   test('a disabled plugin receives nothing', async () => {
      await sql.begin((tx) => repo.update(tx, world.workspaceId, installation.id, { enabled: false }));
      const before = ours().length;
      const eventId = randomUUID();
      await sql`
         INSERT INTO outbox_events (id, topic, aggregate_type, aggregate_id, workspace_id, payload, occurred_at, available_at)
         VALUES (${eventId}, 'comment.created', 'comment', ${randomUUID()}, ${world.workspaceId},
                 ${sql.json({ id: eventId } as never)}, now() - interval '5 seconds', now() - interval '5 seconds')`;
      await sql`UPDATE plugin_hook_state SET next_fire_at = now() - interval '1 second' WHERE installation_id = ${installation.id}`;
      await runner().tick();
      assert.equal(ours().length, before);
   });
});
