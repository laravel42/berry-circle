import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';

/** The plugin tables exist with the constraints the repositories rely on. */

const url = process.env.BERRY_TEST_DATABASE_URL;

const TABLES = [
   'plugin_installations',
   'plugin_files',
   'plugin_secrets',
   'plugin_storage',
   'plugin_invocations',
   'plugin_tokens',
   'plugin_hook_state',
   'plugin_event_cursor',
   'plugin_tool_approvals',
];

describe('plugin schema', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   before(() => {
      sql = openDatabase({ url: url as string });
   });
   after(async () => {
      await closeDatabase(sql);
   });

   test('every plugin table exists and carries workspace_id', async () => {
      for (const table of TABLES) {
         const [exists] = await sql`SELECT to_regclass(${table}) AS name`;
         assert.equal(exists?.name, table, `${table} exists`);
         // The cursor is the one documented exception: a single global row.
         if (table === 'plugin_event_cursor') continue;
         const rows = await sql`
            SELECT column_name FROM information_schema.columns
             WHERE table_name = ${table} AND column_name = 'workspace_id'`;
         assert.equal(rows.length, 1, `${table}.workspace_id`);
      }
   });

   test('the event cursor is a single row', async () => {
      await sql`INSERT INTO plugin_event_cursor (id) VALUES (1) ON CONFLICT DO NOTHING`;
      const rows = await sql`SELECT id FROM plugin_event_cursor`;
      assert.equal(rows.length, 1);
      await assert.rejects(sql`INSERT INTO plugin_event_cursor (id) VALUES (2)`);
   });

   test('personal tokens carry nullable scopes', async () => {
      const [column] = await sql`
         SELECT is_nullable, data_type FROM information_schema.columns
          WHERE table_name = 'personal_api_tokens' AND column_name = 'scopes'`;
      assert.equal(column?.is_nullable, 'YES');
      assert.equal(column?.data_type, 'ARRAY');
   });
});
