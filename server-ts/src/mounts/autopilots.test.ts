import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import { personalTokenResolver } from '../auth/credentials.ts';
import { SessionService } from '../auth/sessions.ts';
import { issueTestToken } from '../auth/test-credentials.ts';
import { AutopilotRepository } from '../autopilots/repository.ts';
import type { FireInput, FireOutcome } from '../autopilots/fire.ts';
import { cleanupWorkspace, seedWorkspace, testSealer, type Fixture } from '../autopilots/test-fixture.ts';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { createApp, type BerryApp } from '../http/app.ts';
import { IdempotencyStore } from '../http/idempotency.ts';
import { Registry } from '../http/registry.ts';
import { autopilotMounts } from './autopilots.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('/api/v1/autopilots', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let app: BerryApp;
   let repo: AutopilotRepository;
   let fixture: Fixture;
   let token: string;
   let fired: FireInput[];

   before(async () => {
      sql = openDatabase({ url: url as string });
      const sessions = new SessionService({ sql, auth: null, bearer: [personalTokenResolver(sql)] });
      repo = new AutopilotRepository({ sql, sealer: testSealer() });
      const registry = new Registry();
      registry.registerAll(
         autopilotMounts({
            sessions,
            sql,
            autopilots: repo,
            idempotency: new IdempotencyStore(sql),
            fire: async (input): Promise<FireOutcome> => {
               fired.push(input);
               return { autopilotRunId: randomUUID(), status: 'enqueued', reasonCode: null, runId: randomUUID(), issueId: null };
            },
         })
      );
      app = createApp(registry);
      fixture = await seedWorkspace(sql, 'mount');
      token = await issueTestToken(sql, fixture.userId);
   });

   after(async () => {
      await cleanupWorkspace(sql, fixture);
      await closeDatabase(sql);
   });

   beforeEach(() => {
      fired = [];
   });

   function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
      return app.request(path, {
         method,
         headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            ...headers,
         },
         ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
   }

   function key(): Record<string, string> {
      return { 'idempotency-key': `test-${randomUUID()}` };
   }

   async function createOne(): Promise<Record<string, unknown>> {
      const response = await call('POST', '/api/v1/autopilots', {
         workspaceId: fixture.workspaceId,
         name: 'Nightly triage',
         assigneeType: 'agent',
         assigneeId: fixture.agentId,
         promptTemplate: 'Triage.',
         executionMode: 'create_issue',
         boardId: fixture.boardId,
      }, key());
      assert.equal(response.status, 201);
      return (await response.json()) as Record<string, unknown>;
   }

   test('an autopilot is created at version 1 and listed in its workspace', async () => {
      const created = await createOne();
      assert.equal(created.version, 1);
      assert.equal(created.status, 'active');
      assert.equal(created.quotaPeriod, 'none');
      const list = await call('GET', `/api/v1/autopilots?workspaceId=${fixture.workspaceId}`);
      const body = (await list.json()) as { nodes: { id: string }[] };
      assert.ok(body.nodes.some((node) => node.id === created.id));
   });

   test('the list says what makes each autopilot run, without asking after its triggers', async () => {
      const created = await createOne();
      const before = await call('GET', `/api/v1/autopilots?workspaceId=${fixture.workspaceId}`);
      const quiet = ((await before.json()) as { nodes: Array<Record<string, unknown>> }).nodes.find(
         (node) => node.id === created.id
      );
      assert.deepEqual(quiet?.triggerKinds, [], 'nothing fires it yet');

      assert.equal(
         (
            await call('POST', `/api/v1/autopilots/${created.id}/triggers`, {
               kind: 'cron',
               expression: '0 9 * * 1-5',
               timezone: 'Europe/Rome',
            })
         ).status,
         201
      );
      const after = await call('GET', `/api/v1/autopilots?workspaceId=${fixture.workspaceId}`);
      const scheduled = ((await after.json()) as { nodes: Array<Record<string, unknown>> }).nodes.find(
         (node) => node.id === created.id
      );
      assert.deepEqual(scheduled?.triggerKinds, ['cron']);
   });

   test('an agent from nowhere is a validation error at the field that named it', async () => {
      const response = await call('POST', '/api/v1/autopilots', {
         workspaceId: fixture.workspaceId, name: 'x', assigneeType: 'agent', assigneeId: randomUUID(),
         promptTemplate: 'x', executionMode: 'create_issue', boardId: fixture.boardId,
      }, key());
      assert.equal(response.status, 422);
      const body = (await response.json()) as { error: { details: { fields: { path: string }[] } } };
      assert.equal(body.error.details.fields[0]?.path, '/assigneeId');
   });

   test('a webhook secret is shown once, never cached, and never read back', async () => {
      const created = await createOne();
      const response = await call('POST', `/api/v1/autopilots/${created.id}/triggers`, {
         kind: 'webhook', eventFilters: ['deploy'],
      });
      assert.equal(response.status, 201);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const body = (await response.json()) as { secrets: { token: string; signingSecret: string; ingressPath: string } };
      assert.equal(body.secrets.ingressPath, `/api/webhooks/autopilots/${body.secrets.token}`);

      const detail = await (await call('GET', `/api/v1/autopilots/${created.id}`)).text();
      assert.equal(detail.includes(body.secrets.token), false);
      assert.equal(detail.includes(body.secrets.signingSecret), false);
      assert.ok(detail.includes('"tokenHint"'));
   });

   test('the cron preview lists the next firings, and a bad schedule says where it is wrong', async () => {
      const ok = await call('GET', '/api/v1/autopilots/cron-preview?expression=0%209%20*%20*%201-5&timezone=Europe%2FRome&count=3');
      assert.equal(ok.status, 200);
      const body = (await ok.json()) as { times: string[] };
      assert.equal(body.times.length, 3);

      const bad = await call('GET', '/api/v1/autopilots/cron-preview?expression=nope&timezone=UTC');
      assert.equal(bad.status, 422);
      const failure = (await bad.json()) as { error: { details: { fields: { path: string }[] } } };
      assert.equal(failure.error.details.fields[0]?.path, '/expression');
   });

   test('run now fires the autopilot by hand, as the caller', async () => {
      const created = await createOne();
      const response = await call('POST', `/api/v1/autopilots/${created.id}/run`, {}, key());
      assert.equal(response.status, 202);
      assert.deepEqual(fired.map((input) => [input.autopilotId, input.source, input.requestedBy]), [
         [created.id, 'manual', fixture.userId],
      ]);
   });

   test('replaying a delivery fires again with the stored payload and records the replay', async () => {
      const created = await createOne();
      const deliveryId = await repo.recordDelivery({
         workspaceId: fixture.workspaceId, autopilotId: created.id as string, triggerId: null,
         event: 'deploy', status: 'accepted', payload: { build: 7 }, failureReason: null, replayOf: null,
      });
      const response = await call('POST', `/api/v1/autopilots/${created.id}/deliveries/${deliveryId}/replay`, {}, key());
      assert.equal(response.status, 202);
      assert.equal(fired[0]?.source, 'replay');
      assert.deepEqual(fired[0]?.payload, { build: 7 });
      const [replay] = await sql`SELECT status FROM webhook_deliveries WHERE replay_of = ${deliveryId}`;
      assert.equal(replay?.status, 'accepted');

      const detail = await call('GET', `/api/v1/autopilots/${created.id}/deliveries/${deliveryId}`);
      assert.equal(detail.status, 200);
      assert.deepEqual(((await detail.json()) as { payload: unknown }).payload, { build: 7 });
   });

   test('a delivery refused at the signature check cannot be replayed', async () => {
      const created = await createOne();
      const deliveryId = await repo.recordDelivery({
         workspaceId: fixture.workspaceId, autopilotId: created.id as string, triggerId: null,
         event: null, status: 'rejected', payload: null, failureReason: 'SIGNATURE_MISMATCH', replayOf: null,
      });
      const response = await call('POST', `/api/v1/autopilots/${created.id}/deliveries/${deliveryId}/replay`, {}, key());
      assert.equal(response.status, 409);
      assert.equal(fired.length, 0);
   });

   test("a viewer is told 404 for an autopilot or trigger that is absent or another workspace's, and 403 only for this one's", async () => {
      const own = await createOne();
      const ownId = own.id as string;
      const made = await call('POST', `/api/v1/autopilots/${ownId}/triggers`, {
         kind: 'cron', expression: '0 9 * * *', timezone: 'UTC',
      });
      assert.equal(made.status, 201);
      const ownTrigger = ((await made.json()) as { trigger: { id: string } }).trigger.id;
      const other = await seedWorkspace(sql, 'mount-other');
      const [viewer] = await sql`
         INSERT INTO users (id, email, name)
         VALUES (${randomUUID()}, ${`viewer-${randomUUID().slice(0, 8)}@berry.test`}, 'Viewer')
         RETURNING id`;
      const viewerId = viewer!.id as string;
      try {
         await sql`
            INSERT INTO workspace_memberships (workspace_id, user_id, role)
            VALUES (${fixture.workspaceId}, ${viewerId}, 'viewer')`;
         const viewerToken = await issueTestToken(sql, viewerId);
         const theirs = await repo.create(other.workspaceId, {
            name: 'Theirs', description: null, assigneeType: 'agent', assigneeId: other.agentId,
            promptTemplate: 'x', executionMode: 'create_issue', boardId: other.boardId, issueId: null,
            quotaPeriod: 'none', quotaMax: null,
         }, other.userId);
         const theirTrigger = await repo.addCronTrigger(other.workspaceId, theirs.id, {
            expression: '0 9 * * *', timezone: 'UTC', enabled: true,
         });
         const as = (method: string, path: string, body?: unknown) =>
            app.request(`/api/v1/autopilots${path}`, {
               method,
               headers: { authorization: `Bearer ${viewerToken}`, 'content-type': 'application/json' },
               ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
         for (const [method, body] of [['PATCH', { name: 'x' }], ['DELETE', undefined]] as const) {
            assert.equal((await as(method, `/${theirs.id}`, body)).status, 404, `${method}: another workspace's autopilot`);
            assert.equal((await as(method, `/${randomUUID()}`, body)).status, 404, `${method}: no autopilot at all`);
            assert.equal((await as(method, `/${ownId}`, body)).status, 403, `${method}: this workspace's autopilot`);
         }
         const triggerProbes = [['PATCH', '', { enabled: false }], ['DELETE', '', undefined], ['POST', '/rotate', undefined]] as const;
         for (const [method, suffix, body] of triggerProbes) {
            const at = (triggerId: string) => as(method, `/${ownId}/triggers/${triggerId}${suffix}`, body);
            assert.equal((await at(theirTrigger.id)).status, 404, `${method} ${suffix}: another workspace's trigger`);
            assert.equal((await at(randomUUID())).status, 404, `${method} ${suffix}: no trigger at all`);
            assert.equal((await at(ownTrigger)).status, 403, `${method} ${suffix}: this workspace's trigger`);
         }
      } finally {
         await sql`DELETE FROM personal_api_tokens WHERE user_id = ${viewerId}`;
         await sql`DELETE FROM workspace_memberships WHERE user_id = ${viewerId}`;
         await sql`DELETE FROM users WHERE id = ${viewerId}`;
         await cleanupWorkspace(sql, other);
      }
   });

   test('pausing then archiving takes it off the list', async () => {
      const created = await createOne();
      const paused = await call('PATCH', `/api/v1/autopilots/${created.id}`, { status: 'paused' });
      assert.equal(((await paused.json()) as { status: string }).status, 'paused');
      assert.equal((await call('DELETE', `/api/v1/autopilots/${created.id}`)).status, 204);
      const list = (await (await call('GET', `/api/v1/autopilots?workspaceId=${fixture.workspaceId}`)).json()) as { nodes: { id: string }[] };
      assert.equal(list.nodes.some((node) => node.id === created.id), false);
   });
});
