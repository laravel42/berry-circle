import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { cleanupWorld, createIssue, seedWorld, type World } from './fixture.ts';
import {
   HierarchyCycle,
   ParentNotFound,
   blockedByEarlierStage,
   childIssueIds,
   nextStageReady,
   setParent,
} from './hierarchy.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('hierarchy', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let world: World;
   let other: World;
   before(async () => {
      sql = openDatabase({ url: url as string });
      world = await seedWorld(sql, 'tree');
      other = await seedWorld(sql, 'tree-other');
   });
   after(async () => {
      await cleanupWorld(sql, world);
      await cleanupWorld(sql, other);
      await closeDatabase(sql);
   });

   test('an issue cannot become a descendant of itself', async () => {
      const child = await createIssue(sql, world);
      await setParent(sql, { workspaceId: world.workspaceId, issueId: child, parentId: world.issueId, stage: null });
      await assert.rejects(
         setParent(sql, { workspaceId: world.workspaceId, issueId: world.issueId, parentId: child, stage: null }),
         HierarchyCycle
      );
   });

   test('a parent from another workspace is not found', async () => {
      const child = await createIssue(sql, world);
      await assert.rejects(
         setParent(sql, { workspaceId: world.workspaceId, issueId: child, parentId: other.issueId, stage: null }),
         ParentNotFound
      );
   });

   test('stage two waits for stage one, then is released as a group', async () => {
      const parent = await createIssue(sql, world, { title: 'Staged' });
      const a1 = await createIssue(sql, world, { parentId: parent, stage: 1, status: 'todo' });
      const a2 = await createIssue(sql, world, { parentId: parent, stage: 1, status: 'todo' });
      const b1 = await createIssue(sql, world, { parentId: parent, stage: 2, status: 'todo' });
      const c1 = await createIssue(sql, world, { parentId: parent, stage: 3, status: 'todo' });

      assert.equal((await childIssueIds(sql, parent)).length, 4);
      assert.equal(await blockedByEarlierStage(sql, b1), true);
      assert.equal(await blockedByEarlierStage(sql, a1), false);

      await sql`UPDATE issues SET status = 'done' WHERE id = ${a1}`;
      assert.deepEqual(await nextStageReady(sql, a1), []);
      await sql`UPDATE issues SET status = 'cancelled' WHERE id = ${a2}`;
      assert.deepEqual(await nextStageReady(sql, a2), [b1]);
      assert.equal(await blockedByEarlierStage(sql, b1), false);
      assert.equal(await blockedByEarlierStage(sql, c1), true);
   });
});
