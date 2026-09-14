import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Sql } from '../db/pool.ts';
import { assertBerryDatabase, NotABerryDatabase } from './reset.ts';
import * as reset from './reset.ts';

/** A pool that answers each query in turn with a canned result. */
function answering(...results: unknown[][]): Sql {
   let next = 0;
   return (async () => results[next++] ?? []) as unknown as Sql;
}

test('a database carrying the Berry schema is accepted', async () => {
   const sql = answering([
      { ledger: 'berry_schema_migrations', projects: 'projects' },
   ]);
   await assertBerryDatabase(sql);
});

test('a database with no Berry schema is refused', async () => {
   const sql = answering([{ ledger: null, projects: null }], [{ db: 'berry', host: '127.0.0.1' }]);
   await assert.rejects(assertBerryDatabase(sql), NotABerryDatabase);
});

test('the refusal names the database and server it declined', async () => {
   const sql = answering([{ ledger: null, projects: null }], [{ db: 'berry', host: '127.0.0.1' }]);
   await assert.rejects(assertBerryDatabase(sql), (error: Error) => {
      assert.match(error.message, /"berry"/);
      assert.match(error.message, /127\.0\.0\.1/);
      return true;
   });
});

// A second PostgreSQL listening on the same port, holding an unrelated `berry`
// database, is the failure this check exists for — and it is not hypothetical.
test('a half-migrated database is refused rather than half-emptied', async () => {
   const sql = answering(
      [{ ledger: 'berry_schema_migrations', projects: null }],
      [{ db: 'berry', host: null }]
   );
   await assert.rejects(assertBerryDatabase(sql), NotABerryDatabase);
});

test('the reset has no way to delete a repository', () => {
   // Repositories are GitHub's now, owned by the workspace's organization.
   // Deleting somebody's code because a development database was reset would
   // be unrecoverable, so the capability is absent rather than guarded.
   const exported = Object.keys(reset);
   assert.ok(
      !exported.some((name) => /repositor/i.test(name)),
      `the reset should expose nothing repository-shaped, got: ${exported.join(', ')}`
   );
});
