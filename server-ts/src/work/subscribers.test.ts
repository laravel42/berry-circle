import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { cleanupWorld, createIssue, seedWorld, type World } from './fixture.ts';
import { recordIssueEvent } from './outbox.ts';
import {
   isSubscribed,
   listSubscribers,
   notifySubscribers,
   subscribe,
   subtreeIssueIds,
   unsubscribe,
} from './subscribers.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('subscribers', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let world: World;
   let other: World;
   before(async () => {
      sql = openDatabase({ url: url as string });
      world = await seedWorld(sql, 'subs');
      other = await seedWorld(sql, 'subs-other');
   });
   after(async () => {
      await cleanupWorld(sql, world);
      await cleanupWorld(sql, other);
      await closeDatabase(sql);
   });

   test('only members subscribe, and subscribing twice is one row', async () => {
      const count = await subscribe(sql, {
         workspaceId: world.workspaceId,
         issueIds: [world.issueId],
         userIds: [world.memberId, other.ownerId],
         reason: 'manual',
      });
      assert.equal(count, 1);
      assert.equal(
         await subscribe(sql, { workspaceId: world.workspaceId, issueIds: [world.issueId], userIds: [world.memberId], reason: 'manual' }),
         0
      );
      const subscribers = await listSubscribers(sql, world.issueId);
      assert.deepEqual(subscribers.map((entry) => entry.userId), [world.memberId]);
      assert.equal(await unsubscribe(sql, { issueIds: [world.issueId], userId: world.memberId }), 1);
      assert.equal(await isSubscribed(sql, world.issueId, world.memberId), false);
   });

   test('a subtree is the issue and every descendant', async () => {
      const child = await createIssue(sql, world, { parentId: world.issueId });
      const grandchild = await createIssue(sql, world, { parentId: child });
      const ids = await subtreeIssueIds(sql, world.issueId);
      assert.deepEqual(new Set(ids), new Set([world.issueId, child, grandchild]));
   });

   test('notification reaches subscribers but not the actor, and a mention is a mention', async () => {
      await subscribe(sql, { workspaceId: world.workspaceId, issueIds: [world.issueId], userIds: [world.ownerId, world.memberId], reason: 'manual' });
      const event = await recordIssueEvent(sql, { issueId: world.issueId, type: 'comment.created', actor: { type: 'user', id: world.ownerId }, payload: {} });
      const written = await notifySubscribers(sql, {
         workspaceId: world.workspaceId,
         issueId: world.issueId,
         sourceEventId: event.id,
         eventType: 'comment.created',
         category: 'comments',
         actor: { type: 'user', id: world.ownerId },
         title: 'WRK-1 Root task',
         body: 'hello',
         mentionedUserIds: [world.viewerId],
      });
      assert.equal(written, 2);
      const rows = await sql`
         SELECT recipient_id, category FROM inbox_items WHERE source_event_id = ${event.id} ORDER BY category`;
      assert.deepEqual(
         rows.map((row) => [row.recipient_id, row.category]),
         [
            [world.memberId, 'comments'],
            [world.viewerId, 'mentions'],
         ]
      );
   });

   test('a category switched off in preferences is not delivered', async () => {
      await sql`
         INSERT INTO notification_preferences (workspace_id, user_id, preferences)
         VALUES (${world.workspaceId}, ${world.memberId},
                 ${sql.json({ inApp: { comments: false } } as never)})
         ON CONFLICT (workspace_id, user_id) DO UPDATE SET preferences = EXCLUDED.preferences`;
      const event = await recordIssueEvent(sql, { issueId: world.issueId, type: 'comment.created', actor: { type: 'user', id: world.ownerId }, payload: {} });
      await notifySubscribers(sql, {
         workspaceId: world.workspaceId,
         issueId: world.issueId,
         sourceEventId: event.id,
         eventType: 'comment.created',
         category: 'comments',
         actor: { type: 'user', id: world.ownerId },
         title: 'WRK-1 Root task',
         body: null,
         mentionedUserIds: [],
      });
      const rows = await sql`SELECT 1 FROM inbox_items WHERE source_event_id = ${event.id} AND recipient_id = ${world.memberId}`;
      assert.equal(rows.length, 0);
   });
});
