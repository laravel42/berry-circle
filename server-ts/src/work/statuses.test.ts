import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { cleanupWorld, createIssue, seedWorld, type World } from './fixture.ts';
import {
   StatusNameTaken,
   StatusOrderMismatch,
   SystemStatusProtected,
   archiveStatus,
   createStatus,
   listStatuses,
   reorderStatuses,
   resolveStatus,
   statusCreateSchema,
} from './statuses.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('custom statuses', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let world: World;
   before(async () => {
      sql = openDatabase({ url: url as string });
      world = await seedWorld(sql, 'status');
   });
   after(async () => {
      await cleanupWorld(sql, world);
      await closeDatabase(sql);
   });

   test('a custom status joins its category and its name is unique', async () => {
      const qa = await createStatus(sql, world.workspaceId, world.ownerId, statusCreateSchema.parse({ name: 'QA', category: 'in_review', color: '#8b5cf6' }));
      assert.equal(qa.category, 'in_review');
      assert.equal(qa.isSystem, false);
      assert.match(qa.key, /^c[0-9a-f]{12}$/);
      assert.equal((await resolveStatus(sql, world.workspaceId, qa.id)).id, qa.id);
      await assert.rejects(
         createStatus(sql, world.workspaceId, world.ownerId, statusCreateSchema.parse({ name: 'qa', category: 'todo', color: '#111111' })),
         StatusNameTaken
      );
   });

   test('a system status cannot be archived; a custom one can, and leaves its issues on the category', async () => {
      const statuses = await listStatuses(sql, world.workspaceId);
      const system = statuses.find((status) => status.isSystem);
      assert.ok(system);
      await assert.rejects(archiveStatus(sql, world.workspaceId, system.id), SystemStatusProtected);

      const parked = await createStatus(sql, world.workspaceId, world.ownerId, statusCreateSchema.parse({ name: 'Parked', category: 'backlog', color: '#6b7280' }));
      const issueId = await createIssue(sql, world);
      await sql`UPDATE issues SET status_id = ${parked.id} WHERE id = ${issueId}`;
      await archiveStatus(sql, world.workspaceId, parked.id);
      const [row] = await sql`SELECT status::text AS status, status_id FROM issues WHERE id = ${issueId}`;
      assert.deepEqual([row?.status, row?.status_id], ['backlog', null]);
      await assert.rejects(resolveStatus(sql, world.workspaceId, parked.id));
   });

   test('reordering needs the full active set', async () => {
      const statuses = await listStatuses(sql, world.workspaceId);
      const ids = statuses.map((status) => status.id);
      await assert.rejects(reorderStatuses(sql, world.workspaceId, ids.slice(1)), StatusOrderMismatch);
      const reversed = await reorderStatuses(sql, world.workspaceId, [...ids].reverse());
      assert.deepEqual(reversed.map((status) => status.id), [...ids].reverse());
   });
});
