import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { InvalidCredentials, SessionService, SessionUnauthenticated } from './sessions.ts';
import { hashToken } from './tokens.ts';

/**
 * Database-backed session tests, gated the way Go gates its own:
 * `BERRY_TEST_DATABASE_URL` against a database carrying the real migrations.
 * Without it these skip, so the default suite stays offline.
 *
 *   createdb berry_ts_test
 *   psql berry_ts_test < <(pg_dump --schema-only berry)
 *   BERRY_TEST_DATABASE_URL=postgres://... npm test
 */

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('sessions', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let sessions: SessionService;
   const email = `session-test-${Date.now()}@berry.test`;
   let userId: string;

   before(async () => {
      sql = openDatabase({ url: url as string });
      const [row] = await sql`
         INSERT INTO users (email, name, role) VALUES (${email}, 'Session Test', 'member')
         RETURNING id`;
      userId = (row as { id: string }).id;
      // 300 s is the shortest TTL the service accepts.
      sessions = new SessionService({ sql, sessionTtlMs: 300_000 });
   });

   after(async () => {
      await sql`DELETE FROM sessions WHERE user_id = ${userId}`;
      await sql`DELETE FROM users WHERE id = ${userId}`;
      await closeDatabase(sql);
   });

   test('issuing a session returns the raw token exactly once', async () => {
      const issued = await sessions.issueKnownEmail(email);
      assert.equal(issued.user.email, email);
      assert.match(issued.token, /^[A-Za-z0-9_-]{43}$/);

      // Only the hash is stored — a database leak hands over nothing usable.
      const [stored] = await sql`
         SELECT token_hash FROM sessions WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 1`;
      assert.equal((stored as { token_hash: string }).token_hash, hashToken(issued.token));
      assert.notEqual((stored as { token_hash: string }).token_hash, issued.token);
   });

   test('email matching ignores case, because addresses are not case sensitive', async () => {
      const issued = await sessions.issueKnownEmail(email.toUpperCase());
      assert.equal(issued.user.id, userId);
   });

   test('an unknown email is refused without saying so', async () => {
      await assert.rejects(
         () => sessions.issueKnownEmail('definitely-nobody@berry.test'),
         InvalidCredentials
      );
   });

   test('resolving a session stamps last_used_at in the same statement', async () => {
      const issued = await sessions.issueKnownEmail(email);
      const resolved = await sessions.resolveSession(issued.token);
      assert.equal(resolved.id, userId);

      const [row] = await sql`
         SELECT last_used_at FROM sessions WHERE token_hash = ${hashToken(issued.token)}`;
      assert.ok((row as { last_used_at: string | null }).last_used_at, 'last_used_at was not set');
   });

   test('timestamps keep the precision the column holds', async () => {
      const issued = await sessions.issueKnownEmail(email);
      // Go renders every digit PostgreSQL stores; a JavaScript Date would have
      // truncated this to three.
      assert.match(issued.user.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
      assert.ok(!issued.user.createdAt.includes(' '), 'must be RFC 3339, not a PostgreSQL literal');
      assert.ok(!issued.user.createdAt.includes('+'), 'the offset must be normalised to Z');
   });

   test('a revoked session stops resolving', async () => {
      const issued = await sessions.issueKnownEmail(email);
      await sessions.resolveSession(issued.token);
      await sessions.revokeSession(issued.token);
      await assert.rejects(() => sessions.resolveSession(issued.token), SessionUnauthenticated);
   });

   test('revoking an unknown token succeeds, telling the caller nothing', async () => {
      await sessions.revokeSession('a'.repeat(43));
   });

   test('an expired session stops resolving, enforced by storage', async () => {
      const past = new SessionService({
         sql,
         // The minimum TTL, issued far enough in the past that it has lapsed.
         sessionTtlMs: 300_000,
         now: () => new Date(Date.now() - 600_000),
      });
      const issued = await past.issueKnownEmail(email);
      await assert.rejects(() => sessions.resolveSession(issued.token), SessionUnauthenticated);
   });

   test('a token that was never issued does not resolve', async () => {
      await assert.rejects(() => sessions.resolveSession('b'.repeat(43)), SessionUnauthenticated);
   });
});
