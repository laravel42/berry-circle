import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { cleanupWorld, createIssue, seedWorld, type World } from './fixture.ts';
import { createProperty, propertyCreateSchema, setValue } from './properties.ts';
import { issueQuerySchema, runIssueQuery } from './issue-query.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('issue query', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let world: World;
   let other: World;
   let sizeId = '';
   const ids: Record<string, string> = {};

   before(async () => {
      sql = openDatabase({ url: url as string });
      world = await seedWorld(sql, 'query');
      other = await seedWorld(sql, 'query-other');
      ids.todoSmall = await createIssue(sql, world, { status: 'todo' });
      ids.todoLarge = await createIssue(sql, world, { status: 'todo' });
      ids.progress = await createIssue(sql, world, { status: 'in_progress' });
      await createIssue(sql, other, { status: 'todo' });
      const size = await createProperty(sql, world.workspaceId, world.ownerId, propertyCreateSchema.parse({
         name: 'Size',
         kind: 'select',
         options: [
            { id: 's', name: 'S', color: '#111111' },
            { id: 'l', name: 'L', color: '#222222' },
         ],
      }));
      sizeId = size.id;
      await setValue(sql, { workspaceId: world.workspaceId, issueId: ids.todoSmall, propertyId: sizeId, value: 's', actorId: world.ownerId });
      await setValue(sql, { workspaceId: world.workspaceId, issueId: ids.todoLarge, propertyId: sizeId, value: 'l', actorId: world.ownerId });
   });
   after(async () => {
      await cleanupWorld(sql, world);
      await cleanupWorld(sql, other);
      await closeDatabase(sql);
   });

   test('grouping by status counts only this workspace, with facets', async () => {
      const result = await runIssueQuery(sql, world.workspaceId, issueQuerySchema.parse({ workspaceId: world.workspaceId, groupBy: 'status' }));
      const todo = result.groups.find((group) => group.key === 'todo');
      assert.equal(todo?.count, 2);
      assert.equal(result.facets.status.inProgress, 1);
      assert.equal(result.facets.status.backlog, 1);
      assert.equal(result.total, 4);
   });

   test('a property filter narrows the set, and perGroup caps ids but not counts', async () => {
      const small = await runIssueQuery(sql, world.workspaceId, issueQuerySchema.parse({
         workspaceId: world.workspaceId,
         filter: { properties: [{ propertyId: sizeId, op: 'eq', value: 's' }] },
      }));
      assert.deepEqual(small.groups[0]?.issueIds, [ids.todoSmall]);

      const capped = await runIssueQuery(sql, world.workspaceId, issueQuerySchema.parse({
         workspaceId: world.workspaceId,
         filter: { statuses: ['todo'] },
         perGroup: 1,
      }));
      assert.equal(capped.groups[0]?.count, 2);
      assert.equal(capped.groups[0]?.issueIds.length, 1);
   });

   test('grouping by a property puts unset issues under none', async () => {
      const result = await runIssueQuery(sql, world.workspaceId, issueQuerySchema.parse({ workspaceId: world.workspaceId, groupBy: { propertyId: sizeId } }));
      assert.deepEqual(
         Object.fromEntries(result.groups.map((group) => [group.key, group.count])),
         { l: 1, none: 2, s: 1 }
      );
   });
});
