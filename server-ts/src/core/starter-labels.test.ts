import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { cleanupWorld, seedWorld, type World } from '../work/fixture.ts';
import { installStarterLabels, STARTER_LABELS } from './starter-labels.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('starter labels', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let world: World;

   before(async () => {
      sql = openDatabase({ url: url! });
      world = await seedWorld(sql, 'labels');
   });

   after(async () => {
      if (!sql) return;
      await sql`DELETE FROM issue_labels WHERE workspace_id = ${world.workspaceId}`;
      await cleanupWorld(sql, world);
      await closeDatabase(sql);
   });

   test('a workspace gets the set once, and a label a person made under one of the names is theirs', async () => {
      // Seen live: the set was seeded into the demo workspace only, and a
      // person signed in to a workspace they had created saw no labels at all.
      await sql`
         INSERT INTO issue_labels (workspace_id, name, color, created_by)
         VALUES (${world.workspaceId}, 'Bug', '#000000', ${world.ownerId})`;

      const added = await installStarterLabels(sql, world.workspaceId, world.ownerId, new Date().toISOString());
      assert.equal(added, STARTER_LABELS.length - 1, 'every name but the one already taken');

      const again = await installStarterLabels(sql, world.workspaceId, world.ownerId, new Date().toISOString());
      assert.equal(again, 0, 'a second install adds nothing');

      const rows = await sql`
         SELECT name, color FROM issue_labels
          WHERE workspace_id = ${world.workspaceId} AND archived_at IS NULL ORDER BY lower(name)`;
      assert.equal(rows.length, STARTER_LABELS.length);
      const bug = rows.find((row) => (row.name as string).toLowerCase() === 'bug')!;
      assert.equal(bug.name, 'Bug', "the person's spelling stays");
      assert.equal(bug.color, '#000000', "the person's colour stays");
   });
});
