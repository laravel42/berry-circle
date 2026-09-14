// Cross-tenant leakage for /api/v1/autopilots — the four guarantees of
// cross-tenant-leakage.test.ts, asserted for the new mount: U1 (member of W1
// only) never sees, reads, changes or fires W2's autopilot, and an
// unauthenticated caller is refused before any handler runs.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import fc from 'fast-check';
import { personalTokenResolver } from '../auth/credentials.ts';
import { SessionService } from '../auth/sessions.ts';
import { issueTestToken } from '../auth/test-credentials.ts';
import type { FireInput } from '../autopilots/fire.ts';
import { AutopilotRepository } from '../autopilots/repository.ts';
import { cleanupWorkspace, seedWorkspace, testSealer, type Fixture } from '../autopilots/test-fixture.ts';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { createApp, type BerryApp } from '../http/app.ts';
import { IdempotencyStore } from '../http/idempotency.ts';
import { Registry } from '../http/registry.ts';
import { autopilotMounts } from './autopilots.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('autopilots: cross-tenant leakage', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let app: BerryApp;
   let w1: Fixture;
   let w2: Fixture;
   let u1Token: string;
   let w1AutopilotId: string;
   let w2AutopilotId: string;
   let w2TriggerId: string;
   let w2DeliveryId: string;
   const fired: FireInput[] = [];

   before(async () => {
      sql = openDatabase({ url: url as string });
      const sessions = new SessionService({ sql, auth: null, bearer: [personalTokenResolver(sql)] });
      const repo = new AutopilotRepository({ sql, sealer: testSealer() });
      const registry = new Registry();
      registry.registerAll(
         autopilotMounts({
            sessions, sql, autopilots: repo, idempotency: new IdempotencyStore(sql),
            fire: async (input) => {
               fired.push(input);
               return { autopilotRunId: randomUUID(), status: 'enqueued', reasonCode: null, runId: null, issueId: null };
            },
         })
      );
      app = createApp(registry);
      w1 = await seedWorkspace(sql, 'leak-1');
      w2 = await seedWorkspace(sql, 'leak-2');
      u1Token = await issueTestToken(sql, w1.userId);
      const draft = (fixture: Fixture) => ({
         name: `Pilot ${fixture.workspaceId.slice(0, 4)}`, description: null, assigneeType: 'agent' as const,
         assigneeId: fixture.agentId, promptTemplate: 'Go.', executionMode: 'create_issue' as const,
         boardId: fixture.boardId, issueId: null, quotaPeriod: 'none' as const, quotaMax: null,
      });
      w1AutopilotId = (await repo.create(w1.workspaceId, draft(w1), w1.userId)).id;
      w2AutopilotId = (await repo.create(w2.workspaceId, draft(w2), w2.userId)).id;
      w2TriggerId = (
         await repo.addWebhookTrigger(w2.workspaceId, w2AutopilotId, { eventFilters: [], enabled: true })
      ).trigger.id;
      w2DeliveryId = await repo.recordDelivery({
         workspaceId: w2.workspaceId, autopilotId: w2AutopilotId, triggerId: w2TriggerId, event: 'deploy',
         status: 'accepted', payload: { owner: 'w2' }, failureReason: null, replayOf: null,
      });
   });

   after(async () => {
      await cleanupWorkspace(sql, w1);
      await cleanupWorkspace(sql, w2);
      await closeDatabase(sql);
   });

   function asU1(method: string, path: string, body?: unknown) {
      return app.request(path, {
         method,
         headers: {
            authorization: `Bearer ${u1Token}`,
            'content-type': 'application/json',
            'idempotency-key': `leak-${randomUUID()}`,
         },
         ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
   }

   test('(a) listing W1 never shows W2, and listing W2 is refused', async () => {
      const mine = (await (await asU1('GET', `/api/v1/autopilots?workspaceId=${w1.workspaceId}`)).json()) as { nodes: { id: string }[] };
      assert.ok(mine.nodes.some((node) => node.id === w1AutopilotId));
      assert.equal(mine.nodes.some((node) => node.id === w2AutopilotId), false);
      assert.equal((await asU1('GET', `/api/v1/autopilots?workspaceId=${w2.workspaceId}`)).status, 404);
   });

   test("(b) W2's autopilot reads exactly like one that does not exist", async () => {
      const theirs = await asU1('GET', `/api/v1/autopilots/${w2AutopilotId}`);
      const nobody = await asU1('GET', `/api/v1/autopilots/${randomUUID()}`);
      assert.equal(theirs.status, 404);
      assert.equal(nobody.status, 404);
      const a = (await theirs.json()) as { error: { code: string; message: string } };
      const b = (await nobody.json()) as { error: { code: string; message: string } };
      assert.deepEqual([a.error.code, a.error.message], [b.error.code, b.error.message]);
      for (const sub of ['runs', 'deliveries', 'versions', `deliveries/${w2DeliveryId}`]) {
         assert.equal((await asU1('GET', `/api/v1/autopilots/${w2AutopilotId}/${sub}`)).status, 404, sub);
      }
   });

   test('(c) changing, firing or adding a trigger to W2 is 404 and changes nothing', async () => {
      assert.equal((await asU1('PATCH', `/api/v1/autopilots/${w2AutopilotId}`, { name: 'pwned' })).status, 404);
      assert.equal((await asU1('POST', `/api/v1/autopilots/${w2AutopilotId}/run`, {})).status, 404);
      assert.equal((await asU1('POST', `/api/v1/autopilots/${w2AutopilotId}/triggers`, { kind: 'webhook' })).status, 404);
      assert.equal((await asU1('DELETE', `/api/v1/autopilots/${w2AutopilotId}`)).status, 404);
      assert.equal(
         (await asU1('PUT', `/api/v1/autopilots/${w2AutopilotId}/members`, { members: [{ userId: w1.userId, role: 'subscriber' }] })).status,
         404
      );
      const w2Members = await sql`SELECT 1 FROM autopilot_members WHERE autopilot_id = ${w2AutopilotId}`;
      assert.equal(w2Members.length, 0, 'W1 cannot subscribe itself to W2');
      assert.equal(fired.some((input) => input.autopilotId === w2AutopilotId), false);
      const [row] = await sql`SELECT name, status FROM autopilots WHERE id = ${w2AutopilotId}`;
      assert.notEqual(row?.name, 'pwned');
      assert.equal(row?.status, 'active');
      const triggers = await sql`SELECT 1 FROM autopilot_triggers WHERE autopilot_id = ${w2AutopilotId}`;
      assert.equal(triggers.length, 1, 'only the trigger W2 made itself');
   });

   test("(e) W2's trigger and delivery ids are unreachable through W1's own autopilot", async () => {
      const mine = `/api/v1/autopilots/${w1AutopilotId}`;
      assert.equal((await asU1('PATCH', `${mine}/triggers/${w2TriggerId}`, { enabled: false })).status, 404);
      assert.equal((await asU1('POST', `${mine}/triggers/${w2TriggerId}/rotate`)).status, 404);
      assert.equal((await asU1('DELETE', `${mine}/triggers/${w2TriggerId}`)).status, 404);
      assert.equal((await asU1('GET', `${mine}/deliveries/${w2DeliveryId}`)).status, 404);
      assert.equal((await asU1('POST', `${mine}/deliveries/${w2DeliveryId}/replay`, {})).status, 404);
      const [trigger] = await sql`SELECT enabled FROM autopilot_triggers WHERE id = ${w2TriggerId}`;
      assert.equal(trigger?.enabled, true);
      assert.equal(fired.length, 0);
      const replays = await sql`SELECT 1 FROM webhook_deliveries WHERE replay_of = ${w2DeliveryId}`;
      assert.equal(replays.length, 0);
   });

   test('(d) no session, no answer', async () => {
      const response = await app.request(`/api/v1/autopilots?workspaceId=${w1.workspaceId}`);
      assert.equal(response.status, 401);
   });

   // Property (spec §11 "added to the cross-tenant leakage property tests"),
   // in the style of workspace-reads.absent.property.test.ts: for any read
   // sub-route, W2's autopilot id and a random id answer the same 404 envelope.
   test('(P) any read of W2 is indistinguishable from a random id', async () => {
      const subs = ['', '/runs', '/deliveries', '/versions'];
      await fc.assert(
         fc.asyncProperty(fc.constantFrom(...subs), fc.uuid(), async (sub, random) => {
            const theirs = await asU1('GET', `/api/v1/autopilots/${w2AutopilotId}${sub}`);
            const nobody = await asU1('GET', `/api/v1/autopilots/${random}${sub}`);
            const a = (await theirs.json()) as { error: { code: string; message: string } };
            const b = (await nobody.json()) as { error: { code: string; message: string } };
            return (
               theirs.status === 404 &&
               nobody.status === 404 &&
               a.error.code === b.error.code &&
               a.error.message === b.error.message
            );
         }),
         { numRuns: 100 }
      );
   });
});
