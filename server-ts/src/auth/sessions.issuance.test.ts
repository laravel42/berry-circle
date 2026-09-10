// Feature: auth-and-tenant-isolation, Property 6: Session issuance stores only
// a hash with a bounded expiry.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import fc from 'fast-check';

import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { SessionService } from './sessions.ts';
import { hashToken } from './tokens.ts';

/**
 * Database-backed property test, gated the way the rest of the suite gates its
 * own: `BERRY_TEST_DATABASE_URL` against a database carrying the real
 * migrations. Without it this skips, so the default suite stays offline.
 *
 *   createdb berry_ts_test
 *   psql berry_ts_test < <(pg_dump --schema-only berry)
 *   BERRY_TEST_DATABASE_URL=postgres://... npm test
 */

const url = process.env.BERRY_TEST_DATABASE_URL;

// Each iteration issues a real session against Postgres, so keep the run at the
// ≥100 floor the property suite requires rather than pushing it higher.
const RUNS = 100;

// A fixed in-range TTL (300..2,592,000 seconds), per the property's inputs. Two
// days sits comfortably inside the window and away from either bound.
const TTL_MS = 172_800_000;

// Timestamp columns are `timestamptz`; PostgreSQL keeps microsecond precision
// while a JavaScript Date carries milliseconds, so allow a millisecond of slack
// when comparing the round-tripped expiry against issued_at + ttl.
const TOLERANCE_MS = 1;

describe(
   'Feature: auth-and-tenant-isolation, Property 6: Session issuance stores only a hash with a bounded expiry',
   { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' },
   () => {
      let sql: Sql;
      const email = `session-issuance-${Date.now()}@berry.test`;
      let userId: string;

      before(async () => {
         sql = openDatabase({ url: url as string });
         const [row] = await sql`
            INSERT INTO users (email, name, role)
            VALUES (${email}, 'Session Issuance Test', 'member')
            RETURNING id`;
         userId = (row as { id: string }).id;
      });

      after(async () => {
         await sql`DELETE FROM sessions WHERE user_id = ${userId}`;
         await sql`DELETE FROM users WHERE id = ${userId}`;
         await closeDatabase(sql);
      });

      test(
         'Feature: auth-and-tenant-isolation, Property 6: the persisted row is the token hash, never the raw token, and expires exactly one TTL after issue',
         async () => {
            await fc.assert(
               // Random issue times and metadata, a fixed in-range TTL, repeated
               // issuances — matching the property's generators.
               fc.asyncProperty(
                  fc.date({
                     min: new Date('2000-01-01T00:00:00.000Z'),
                     max: new Date('2100-01-01T00:00:00.000Z'),
                     // fast-check otherwise mixes in new Date(NaN), which no
                     // clock ever returns.
                     noInvalidDate: true,
                  }),
                  fc.option(fc.string({ maxLength: 200 }), { nil: null }),
                  fc.option(fc.string({ maxLength: 64 }), { nil: null }),
                  async (issuedAt, userAgent, ip) => {
                     const sessions = new SessionService({
                        sql,
                        sessionTtlMs: TTL_MS,
                        now: () => new Date(issuedAt.getTime()),
                     });

                     const issued = await sessions.issueForUser(userId, { userAgent, ip });

                     // The raw token is the credential seen once; find its row by
                     // the hash we expect to have been stored.
                     const expectedHash = hashToken(issued.token);
                     const [stored] = await sql`
                        SELECT token_hash, expires_at, created_at
                          FROM sessions
                         WHERE token_hash = ${expectedHash}
                         LIMIT 1`;
                     assert.ok(stored, 'the issued session was persisted under its token hash');

                     const tokenHash = (stored as { token_hash: string }).token_hash;

                     // (a) Only the hash is stored — a database leak hands over
                     // nothing usable — and it equals sha256hex(rawToken).
                     assert.equal(
                        tokenHash,
                        expectedHash,
                        'the stored value must be sha256hex(rawToken)'
                     );
                     assert.notEqual(
                        tokenHash,
                        issued.token,
                        'the stored value must not be the raw token'
                     );

                     // (b) The raw token decodes to at least 256 bits of entropy.
                     const decoded = Buffer.from(issued.token, 'base64url');
                     assert.ok(
                        decoded.length >= 32,
                        `raw token must decode to >= 256 bits, got ${decoded.length * 8}`
                     );

                     // (c) The stored expiry equals the issue time plus the TTL,
                     // within a millisecond of round-trip precision.
                     const storedIssuedAt = new Date(
                        (stored as { created_at: string }).created_at
                     ).getTime();
                     const storedExpiresAt = new Date(
                        (stored as { expires_at: string }).expires_at
                     ).getTime();
                     assert.ok(
                        Math.abs(storedExpiresAt - (storedIssuedAt + TTL_MS)) <= TOLERANCE_MS,
                        `expires_at (${storedExpiresAt}) must equal created_at + ttl (${
                           storedIssuedAt + TTL_MS
                        })`
                     );

                     // The issued expiry the caller was handed agrees with the row.
                     assert.ok(
                        Math.abs(new Date(issued.expiresAt).getTime() - storedExpiresAt) <=
                           TOLERANCE_MS,
                        'the returned expiry must match the persisted expiry'
                     );

                     // Keep the table bounded across ≥100 iterations.
                     await sql`DELETE FROM sessions WHERE token_hash = ${expectedHash}`;
                  }
               ),
               { numRuns: RUNS }
            );
         }
      );
   }
);
