import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { Forbidden, NotFound } from '../identity/errors.ts';
import { cleanupWorld, seedWorld, type World } from './fixture.ts';
import {
   ViewRevisionConflict,
   createView,
   deleteView,
   readPreferences,
   updateView,
   viewCreateSchema,
   writePreferences,
} from './views.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('saved views', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let world: World;
   before(async () => {
      sql = openDatabase({ url: url as string });
      world = await seedWorld(sql, 'views');
   });
   after(async () => {
      await cleanupWorld(sql, world);
      await closeDatabase(sql);
   });

   test('a view is edited at its revision, and a stale revision conflicts', async () => {
      const view = await createView(sql, world.workspaceId, world.memberId, viewCreateSchema.parse({ workspaceId: world.workspaceId, name: 'Mine', query: { statuses: ['todo'] } }));
      const renamed = await updateView(sql, { workspaceId: world.workspaceId, viewId: view.id, actorId: world.memberId, moderator: false, patch: { name: 'Mine now', revision: 1 } });
      assert.equal(renamed.revision, 2);
      await assert.rejects(
         updateView(sql, { workspaceId: world.workspaceId, viewId: view.id, actorId: world.memberId, moderator: false, patch: { name: 'Stale', revision: 1 } }),
         ViewRevisionConflict
      );
   });

   test('a private view is not found by anyone else; a shared one needs a moderator to change', async () => {
      const privateView = await createView(sql, world.workspaceId, world.memberId, viewCreateSchema.parse({ workspaceId: world.workspaceId, name: 'Secret', query: {} }));
      await assert.rejects(
         deleteView(sql, { workspaceId: world.workspaceId, viewId: privateView.id, actorId: world.ownerId, moderator: true }),
         NotFound
      );
      const shared = await createView(sql, world.workspaceId, world.memberId, viewCreateSchema.parse({ workspaceId: world.workspaceId, name: 'Team', visibility: 'workspace', query: {} }));
      await assert.rejects(
         deleteView(sql, { workspaceId: world.workspaceId, viewId: shared.id, actorId: world.viewerId, moderator: false }),
         Forbidden
      );
      await deleteView(sql, { workspaceId: world.workspaceId, viewId: shared.id, actorId: world.ownerId, moderator: true });
   });

   test('preferences remember the active view per person', async () => {
      const view = await createView(sql, world.workspaceId, world.ownerId, viewCreateSchema.parse({ workspaceId: world.workspaceId, name: 'Pref', query: {} }));
      await writePreferences(sql, world.workspaceId, world.ownerId, { activeViewId: view.id, preferences: { layout: 'table' } });
      assert.deepEqual(await readPreferences(sql, world.workspaceId, world.ownerId), { activeViewId: view.id, preferences: { layout: 'table' } });
      assert.deepEqual(await readPreferences(sql, world.workspaceId, world.memberId), { activeViewId: null, preferences: {} });
   });
});
