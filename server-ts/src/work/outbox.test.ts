import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { recordIssueEvent } from './outbox.ts';
import { cleanupWorld, seedWorld, type World } from './fixture.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('work outbox', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let world: World;
   before(async () => {
      sql = openDatabase({ url: url as string });
      world = await seedWorld(sql, 'outbox');
   });
   after(async () => {
      await cleanupWorld(sql, world);
      await closeDatabase(sql);
   });

   test('an issue event is stored with the envelope the stream and the timeline read', async () => {
      const event = await recordIssueEvent(sql, {
         issueId: world.issueId,
         type: 'issue.properties.changed',
         actor: { type: 'user', id: world.ownerId },
         payload: { propertyId: 'p' },
      });
      assert.equal(event.workspaceId, world.workspaceId);
      const [row] = await sql`SELECT topic, payload FROM outbox_events WHERE id = ${event.id}`;
      assert.equal(row?.topic, 'issue.properties.changed');
      const envelope = row?.payload as Record<string, unknown>;
      assert.equal(envelope.issueId, world.issueId);
      assert.deepEqual(envelope.payload, { propertyId: 'p', actor: { type: 'user', id: world.ownerId } });
   });
});
