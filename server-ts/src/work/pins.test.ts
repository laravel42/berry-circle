import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { NotFound } from '../identity/errors.ts';
import { cleanupWorld, createIssue, seedWorld, type World } from './fixture.ts';
import { listPins, pin, reorderPins, unpin } from './pins.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('pins', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let world: World;
   let other: World;
   before(async () => {
      sql = openDatabase({ url: url as string });
      world = await seedWorld(sql, 'pins');
      other = await seedWorld(sql, 'pins-other');
   });
   after(async () => {
      await cleanupWorld(sql, world);
      await cleanupWorld(sql, other);
      await closeDatabase(sql);
   });

   test('pins list in order with titles, reorder, and unpin', async () => {
      const second = await createIssue(sql, world, { title: 'Second' });
      const a = await pin(sql, world.workspaceId, world.memberId, 'issue', world.issueId);
      const b = await pin(sql, world.workspaceId, world.memberId, 'issue', second);
      assert.equal((await pin(sql, world.workspaceId, world.memberId, 'issue', second)).id, b.id);
      assert.deepEqual((await listPins(sql, world.workspaceId, world.memberId)).map((entry) => entry.title), ['Root task', 'Second']);
      const reordered = await reorderPins(sql, world.workspaceId, world.memberId, [b.id, a.id]);
      assert.deepEqual(reordered.map((entry) => entry.id), [b.id, a.id]);
      assert.equal(await unpin(sql, world.workspaceId, world.memberId, a.id), true);
      assert.equal((await listPins(sql, world.workspaceId, world.ownerId)).length, 0);
   });

   test('an issue from another workspace cannot be pinned', async () => {
      await assert.rejects(pin(sql, world.workspaceId, world.memberId, 'issue', other.issueId), NotFound);
   });
});
