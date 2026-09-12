import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { cleanupWorld, seedWorld, type World } from './fixture.ts';
import { assigneeFrequency, batchUpdateSchema, childCreateSchema, defaultBoardId, sortOrderBetween } from './batch.ts';

test('a sort order lands between its neighbours, or after the last', () => {
   assert.equal(sortOrderBetween(1000, 3000), 2000);
   assert.equal(sortOrderBetween(1000, 1001), 2000);
   assert.equal(sortOrderBetween(undefined, 500), 0);
   assert.equal(sortOrderBetween(4000, undefined), 5000);
   assert.equal(sortOrderBetween(), 1000);
});

test('a batch patch needs a field, and not status and statusId together', () => {
   const id = '11111111-1111-4111-8111-111111111111';
   assert.equal(batchUpdateSchema.safeParse({ issueIds: [id], patch: {} }).success, false);
   assert.equal(batchUpdateSchema.safeParse({ issueIds: [id], patch: { status: 'todo', statusId: id } }).success, false);
   assert.equal(batchUpdateSchema.safeParse({ issueIds: [id], patch: { priority: 'high' } }).success, true);
   assert.equal(childCreateSchema.safeParse({}).success, false);
});

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('batch helpers', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let world: World;
   before(async () => {
      sql = openDatabase({ url: url as string });
      world = await seedWorld(sql, 'batch');
   });
   after(async () => {
      await cleanupWorld(sql, world);
      await closeDatabase(sql);
   });

   test('the default board is the workspace\'s oldest', async () => {
      // A workspace is given a board the moment it is created (migration 183),
      // so that one is the oldest and the fixture's own board — inserted after
      // it — does not win, however many boards come later.
      const [given] = await sql`
         SELECT id FROM boards WHERE workspace_id = ${world.workspaceId} AND name = 'Tasks'`;
      assert.ok(given, 'the workspace was given no board');
      assert.equal(await defaultBoardId(sql, world.workspaceId), given.id);
      assert.notEqual(await defaultBoardId(sql, world.workspaceId), world.boardId);
   });

   test('assignee frequency counts what this person assigned, most first', async () => {
      await sql`
         INSERT INTO assignments (issue_id, assignee_type, assignee_id, assigned_by)
         VALUES (${world.issueId}, 'agent', ${world.agentId}, ${world.ownerId}),
                (${world.issueId}, 'agent', ${world.agentId}, ${world.ownerId}),
                (${world.issueId}, 'user', ${world.memberId}, ${world.ownerId})`;
      assert.deepEqual(await assigneeFrequency(sql, world.workspaceId, world.ownerId), [
         { type: 'agent', id: world.agentId, count: 2 },
         { type: 'user', id: world.memberId, count: 1 },
      ]);
      assert.deepEqual(await assigneeFrequency(sql, world.workspaceId, world.memberId), []);
   });
});
