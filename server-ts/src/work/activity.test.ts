import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { CommentRepository } from '../core/comments.ts';
import { cleanupWorld, seedWorld, type World } from './fixture.ts';
import { recordIssueEvent } from './outbox.ts';
import { listIssueActivity } from './activity.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('issue timeline', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let world: World;
   before(async () => {
      sql = openDatabase({ url: url as string });
      world = await seedWorld(sql, 'timeline');
   });
   after(async () => {
      await cleanupWorld(sql, world);
      await closeDatabase(sql);
   });

   test('work events and comments appear in order, with named actors, and page forward', async () => {
      await recordIssueEvent(sql, { issueId: world.issueId, type: 'issue.properties.changed', actor: { type: 'user', id: world.ownerId }, payload: { propertyId: 'x' } });
      const comment = await new CommentRepository(sql).create({ issueId: world.issueId, authorId: world.memberId, body: 'Hi', createdAt: new Date(Date.now() + 5).toISOString() });

      const all = await listIssueActivity(sql, { workspaceId: world.workspaceId, issueId: world.issueId, after: null, limit: 50 });
      assert.deepEqual(all.map((entry) => entry.type), ['issue.properties.changed', 'comment.created']);
      assert.equal(all[0]?.actor?.name, 'Owner');
      assert.equal(all[1]?.commentId, comment.comment.id);
      assert.equal(all[1]?.actor?.name, 'Member');

      const first = all[0];
      assert.ok(first);
      const rest = await listIssueActivity(sql, { workspaceId: world.workspaceId, issueId: world.issueId, after: { createdAt: first.occurredAt, id: first.id }, limit: 50 });
      assert.deepEqual(rest.map((entry) => entry.type), ['comment.created']);
   });
});
