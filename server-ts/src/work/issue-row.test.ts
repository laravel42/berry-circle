import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { IssueRepository, type IssuePatch } from '../core/issues.ts';
import { cleanupWorld, createIssue, seedWorld, type World } from './fixture.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

const NO_CHANGE: IssuePatch = {
   descriptionSet: false,
   dueDateSet: false,
   assigneeSet: false,
   projectSet: false,
};

describe('issue row', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let world: World;
   let issues: IssueRepository;

   before(async () => {
      sql = openDatabase({ url: url as string });
      issues = new IssueRepository(sql);
      world = await seedWorld(sql, 'row');
   });
   after(async () => {
      await cleanupWorld(sql, world);
      await closeDatabase(sql);
   });

   test('a child names its parent and stage, and the parent counts it', async () => {
      const child = await createIssue(sql, world, { title: 'Child', parentId: world.issueId, stage: 1 });
      const read = await issues.get(child);
      assert.equal(read.parentId, world.issueId);
      assert.equal(read.stage, 1);
      assert.deepEqual((await issues.get(world.issueId)).childProgress, { total: 1, done: 0 });

      await sql`UPDATE issues SET status = 'done' WHERE id = ${child}`;
      assert.deepEqual((await issues.get(world.issueId)).childProgress, { total: 1, done: 1 });
   });

   test('a custom status is set with its category and dropped by a plain status change', async () => {
      const [definition] = await sql`
         INSERT INTO issue_status_definitions (workspace_id, key, name, category, color, sort_order)
         VALUES (${world.workspaceId}, 'crow', 'Row QA', 'in_review', '#8b5cf6', 4200)
         RETURNING id`;
      const statusId = definition?.id as string;
      const issueId = await createIssue(sql, world, { status: 'in_progress' });

      const set = await issues.update({
         issueId,
         patch: { ...NO_CHANGE, status: 'in_review', statusId },
         actorId: world.ownerId,
      });
      assert.equal(set.issue.statusId, statusId);
      assert.equal(set.issue.status, 'inReview');

      const back = await issues.update({
         issueId,
         patch: { ...NO_CHANGE, status: 'todo' },
         actorId: world.ownerId,
      });
      assert.equal(back.issue.statusId, null);
   });
});
