import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { FireInput } from '../autopilots/fire.ts';
import { AutopilotRepository } from '../autopilots/repository.ts';
import { newWebhookToken, signBody } from '../autopilots/signing.ts';
import { cleanupWorkspace, seedWorkspace, testSealer, type Fixture } from '../autopilots/test-fixture.ts';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { createApp, type BerryApp } from '../http/app.ts';
import { Registry } from '../http/registry.ts';
import { createLogger } from '../observability/log.ts';
import { autopilotWebhookMounts } from './autopilot-webhooks.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('autopilot webhook ingress', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let app: BerryApp;
   let repo: AutopilotRepository;
   let fixture: Fixture;
   let fired: FireInput[];
   let autopilotId: string;
   let token: string;
   let secret: string;

   before(async () => {
      sql = openDatabase({ url: url as string });
      repo = new AutopilotRepository({ sql, sealer: testSealer() });
      const registry = new Registry();
      registry.registerAll(
         autopilotWebhookMounts({
            autopilots: repo,
            logger: createLogger('autopilot-webhook-test'),
            fire: async (input) => {
               fired.push(input);
               return { autopilotRunId: randomUUID(), status: 'enqueued', reasonCode: null, runId: randomUUID(), issueId: null };
            },
         })
      );
      app = createApp(registry);
      fixture = await seedWorkspace(sql, 'hook');
      const autopilot = await repo.create(fixture.workspaceId, {
         name: 'On deploy', description: null, assigneeType: 'agent', assigneeId: fixture.agentId,
         promptTemplate: 'Check build {{payload.build}}.', executionMode: 'create_issue',
         boardId: fixture.boardId, issueId: null, quotaPeriod: 'none', quotaMax: null,
      }, fixture.userId);
      autopilotId = autopilot.id;
      const made = await repo.addWebhookTrigger(fixture.workspaceId, autopilotId, { eventFilters: ['deploy'], enabled: true });
      token = made.secrets.token;
      secret = made.secrets.signingSecret;
   });

   after(async () => {
      await cleanupWorkspace(sql, fixture);
      await closeDatabase(sql);
   });

   beforeEach(() => {
      fired = [];
   });

   function post(body: string, headers: Record<string, string>, at = token) {
      return app.request(`/api/webhooks/autopilots/${at}`, {
         method: 'POST',
         headers: { 'content-type': 'application/json', ...headers },
         body,
      });
   }

   async function lastDelivery(): Promise<Record<string, unknown> | undefined> {
      const [row] = await sql`
         SELECT status, failure_reason, event, payload FROM webhook_deliveries
          WHERE autopilot_id = ${autopilotId} ORDER BY received_at DESC, id DESC LIMIT 1`;
      return row;
   }

   test('a signed delivery for a wanted event fires the autopilot with its payload', async () => {
      const body = JSON.stringify({ event: 'deploy', build: 12 });
      const response = await post(body, { 'x-berry-signature': signBody(body, secret) });
      assert.equal(response.status, 202);
      assert.equal(((await response.json()) as { accepted: boolean }).accepted, true);
      assert.deepEqual(fired.map((input) => [input.autopilotId, input.source, input.payload]), [
         [autopilotId, 'webhook', { event: 'deploy', build: 12 }],
      ]);
      const delivery = await lastDelivery();
      assert.equal(delivery?.status, 'accepted');
      assert.equal(delivery?.event, 'deploy');
   });

   test('a wrong signature is refused and recorded without its payload', async () => {
      const body = JSON.stringify({ event: 'deploy' });
      const response = await post(body, { 'x-berry-signature': signBody(body, 'whsec_not-the-secret') });
      assert.equal(response.status, 401);
      assert.equal(fired.length, 0);
      const delivery = await lastDelivery();
      assert.equal(delivery?.status, 'rejected');
      assert.equal(delivery?.failure_reason, 'SIGNATURE_MISMATCH');
      assert.equal(delivery?.payload, null);
   });

   test('an event outside the filters is acknowledged and not fired', async () => {
      const body = JSON.stringify({ build: 3 });
      const response = await post(body, { 'x-berry-signature': signBody(body, secret), 'x-berry-event': 'push' });
      assert.equal(response.status, 202);
      assert.equal(((await response.json()) as { accepted: boolean }).accepted, false);
      assert.equal(fired.length, 0);
      assert.equal((await lastDelivery())?.status, 'filtered');
   });

   test('an unknown token and a malformed one get the same 404', async () => {
      const unknown = await post('{}', {}, newWebhookToken());
      const malformed = await post('{}', {}, 'not-a-token');
      assert.equal(unknown.status, 404);
      assert.equal(malformed.status, 404);
      const a = (await unknown.json()) as { error: { code: string; message: string } };
      const b = (await malformed.json()) as { error: { code: string; message: string } };
      assert.deepEqual([a.error.code, a.error.message], [b.error.code, b.error.message]);
   });
});
