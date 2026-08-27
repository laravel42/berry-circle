import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { openDatabase, closeDatabase, type Sql } from '../db/pool.ts';
import { BerrySessionService } from './session-service.ts';

/**
 * Runs against a real PostgreSQL, because the behaviour worth pinning here is
 * in the SQL: sequence allocation, the tail read, and cascade on delete. A
 * fake would assert that the fake works.
 *
 * Skipped unless BERRY_TEST_DATABASE_URL is set, matching the Go suite's
 * convention for database-backed tests.
 */
const url = process.env.BERRY_TEST_DATABASE_URL;

describe('BerrySessionService', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let sessions: BerrySessionService;
   const appName = 'berry-test';
   const userId = 'test-user';

   before(() => {
      sql = openDatabase({ url: url! });
      sessions = new BerrySessionService({ sql });
   });

   after(async () => {
      await sql`DELETE FROM adk_sessions WHERE app_name = ${appName}`;
      await closeDatabase(sql);
   });

   test('a session round-trips with its state', async () => {
      const created = await sessions.createSession({
         appName, userId, state: { stage: 'planning' },
      });
      const loaded = await sessions.getSession({ appName, userId, sessionId: created.id });
      assert.equal(loaded?.id, created.id);
      assert.deepEqual(loaded?.state, { stage: 'planning' });
      assert.deepEqual(loaded?.events, []);
   });

   test('re-creating an existing session returns it rather than failing', async () => {
      // A resumed run hands back an id it already has.
      const first = await sessions.createSession({ appName, userId, sessionId: 'fixed-id' });
      const second = await sessions.createSession({ appName, userId, sessionId: 'fixed-id' });
      assert.equal(second.id, first.id);
   });

   test('events are appended in order and replayed forwards', async () => {
      const session = await sessions.createSession({ appName, userId });
      for (const text of ['one', 'two', 'three']) {
         await sessions.appendEvent({
            session,
            event: { id: `evt-${text}`, author: 'user', content: { role: 'user', parts: [{ text }] } } as never,
         });
      }

      const loaded = await sessions.getSession({ appName, userId, sessionId: session.id });
      assert.deepEqual(
         loaded?.events.map((event) => event.content?.parts?.[0]?.text),
         ['one', 'two', 'three'],
         'replayed in the order they happened'
      );
   });

   test('numRecentEvents reads the tail, not the head', async () => {
      // Replaying every turn to answer one more grows the prompt until the
      // model refuses it.
      const session = await sessions.createSession({ appName, userId });
      for (const text of ['a', 'b', 'c', 'd']) {
         await sessions.appendEvent({
            session,
            event: { id: `t-${text}`, author: 'user', content: { role: 'user', parts: [{ text }] } } as never,
         });
      }

      const tail = await sessions.getSession({
         appName, userId, sessionId: session.id, config: { numRecentEvents: 2 },
      });
      assert.deepEqual(tail?.events.map((event) => event.content?.parts?.[0]?.text), ['c', 'd']);
   });

   test('the sequence comes from storage, so two writers cannot collide', async () => {
      const session = await sessions.createSession({ appName, userId });
      await Promise.all(
         ['x', 'y', 'z'].map((text) =>
            sessions.appendEvent({
               session,
               event: { id: `p-${text}`, author: 'user', content: { role: 'user', parts: [{ text }] } } as never,
            })
         )
      );

      const rows = await sql`
         SELECT sequence FROM adk_session_events
          WHERE app_name = ${appName} AND user_id = ${userId} AND session_id = ${session.id}
          ORDER BY sequence`;
      // Strings, because bigint is rendered as text rather than risking a
      // double losing precision.
      assert.deepEqual(rows.map((row) => row.sequence), ['0', '1', '2'], 'contiguous, no duplicates');
   });

   test('the payload is stored as an object, never a quoted string', async () => {
      // A jsonb string is the whole envelope escaped, and every consumer then
      // fails to decode it.
      const session = await sessions.createSession({ appName, userId });
      await sessions.appendEvent({
         session,
         event: { id: 'shape', author: 'user', content: { role: 'user', parts: [{ text: 'hi' }] } } as never,
      });

      const [row] = await sql`
         SELECT jsonb_typeof(payload) AS kind FROM adk_session_events
          WHERE session_id = ${session.id}`;
      assert.equal(row?.kind, 'object');
   });

   test('deleting a session takes its transcript with it', async () => {
      const session = await sessions.createSession({ appName, userId });
      await sessions.appendEvent({
         session,
         event: { id: 'gone', author: 'user', content: { role: 'user', parts: [{ text: 'bye' }] } } as never,
      });

      await sessions.deleteSession({ appName, userId, sessionId: session.id });
      assert.equal(await sessions.getSession({ appName, userId, sessionId: session.id }), undefined);
      const [row] = await sql`
         SELECT count(*)::int AS remaining FROM adk_session_events WHERE session_id = ${session.id}`;
      assert.equal(row?.remaining, 0, 'cascade, not an orphaned transcript');
   });

   test('listing reports totals rather than the size of the page', async () => {
      const listed = await sessions.listSessions({ appName, userId, limit: 2 });
      assert.ok(listed.totalItems >= listed.sessions.length);
      assert.equal(listed.limit, 2);
      assert.equal(listed.page, 1);
      assert.equal(listed.totalPages, Math.ceil(listed.totalItems / 2));
      assert.ok(listed.sessions.every((session) => session.events.length === 0), 'no transcripts in a listing');
   });
});
