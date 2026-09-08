import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Sql } from '../db/pool.ts';
import { ConfigError } from '../identity/errors.ts';
import { SessionService } from './sessions.ts';

/**
 * TTL boundary refusal (Requirement 3.2).
 *
 * The issuance guard rejects a TTL outside 300..2,592,000 seconds before any
 * token is generated or persisted, so an out-of-range lifetime mints nothing.
 * This is a pure unit test: `sql` is a fake that answers the user lookup and
 * fails loudly if issuance ever reaches an INSERT, which proves no token was
 * persisted. No database is required.
 */

const MIN_TTL_MS = 300_000;
const MAX_TTL_MS = 2_592_000_000;

/** A user row shaped like the SELECT in issueKnownEmail returns. */
const userRow = {
   id: 'user-1',
   email: 'ttl@berry.test',
   name: 'TTL Test',
   avatar_url: null,
   role: 'member',
   last_workspace_id: null,
   created_at: '2026-01-01T00:00:00Z',
   updated_at: '2026-01-01T00:00:00Z',
};

/**
 * A tagged-template `sql` fake. It answers the user SELECT with `userRow` and
 * records whether any INSERT (i.e. token persistence) was attempted. Because
 * the guard runs before the INSERT, `insertAttempted` must stay false for an
 * out-of-range TTL.
 */
function fakeSql(): { sql: Sql; get insertAttempted(): boolean } {
   let insertAttempted = false;
   const sql = ((strings: TemplateStringsArray): Promise<unknown[]> => {
      const query = strings.join(' ');
      if (/insert\s+into\s+sessions/i.test(query)) {
         insertAttempted = true;
         throw new Error('INSERT reached: a token was persisted against a bad TTL');
      }
      // Any SELECT — the user lookup — yields the known user.
      return Promise.resolve([userRow]);
   }) as unknown as Sql;
   return {
      sql,
      get insertAttempted() {
         return insertAttempted;
      },
   };
}

describe('session TTL boundary refusal', () => {
   test('a TTL below the minimum throws ConfigError and persists no token', async () => {
      const spy = fakeSql();
      const sessions = new SessionService({ sql: spy.sql, sessionTtlMs: MIN_TTL_MS - 1 });

      await assert.rejects(() => sessions.issueKnownEmail(userRow.email), ConfigError);
      assert.equal(spy.insertAttempted, false, 'no token should be persisted for a below-min TTL');
   });

   test('a TTL above the maximum throws ConfigError and persists no token', async () => {
      const spy = fakeSql();
      const sessions = new SessionService({ sql: spy.sql, sessionTtlMs: MAX_TTL_MS + 1 });

      await assert.rejects(() => sessions.issueKnownEmail(userRow.email), ConfigError);
      assert.equal(spy.insertAttempted, false, 'no token should be persisted for an above-max TTL');
   });

   test('an in-range TTL passes the guard and reaches persistence', async () => {
      const spy = fakeSql();
      const sessions = new SessionService({ sql: spy.sql, sessionTtlMs: MIN_TTL_MS });

      // The guard is satisfied, so issuance proceeds to the INSERT — which the
      // fake turns into a throw. The point is that it got there at all, unlike
      // the out-of-range cases above.
      await assert.rejects(() => sessions.issueKnownEmail(userRow.email), /INSERT reached/);
      assert.equal(spy.insertAttempted, true, 'an in-range TTL must reach token persistence');
   });
});
