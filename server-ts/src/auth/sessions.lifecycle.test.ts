// Feature: auth-and-tenant-isolation, Property 7: Session lifecycle
// round-trip — issue, resolve, revoke, stay rejected.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import fc from 'fast-check';

import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { SessionService, SessionUnauthenticated, type User } from './sessions.ts';
import { hashToken } from './tokens.ts';

/**
 * Database-backed lifecycle property, gated on `BERRY_TEST_DATABASE_URL` the
 * same way the rest of the server suite is: without a database carrying the
 * real migrations these self-skip, so a fresh `pnpm test:server` stays green
 * offline.
 *
 * Property 7 drives a session through a randomized-but-valid sequence of
 * operations and asserts the whole-lifecycle contract:
 *
 *   - a live `resolve` returns the issuing user and strictly advances
 *     `last_used_at`;
 *   - once the session is expired or revoked (including via sign-out), every
 *     later resolve fails with the 401-equivalent `SessionUnauthenticated`;
 *   - sign-out is a 204 for a known token and for an unknown token alike.
 *
 * Expiry is not real time here: the service takes an injectable `now`, so an
 * "expire" step issues its own short-lived session through a clock pinned in
 * the past, which storage then rejects on the next resolve.
 * (Requirements 3.3, 3.4, 3.5, 3.6, 3.7, 3.8.)
 */

const url = process.env.BERRY_TEST_DATABASE_URL;

// Enough iterations to satisfy the ≥100 floor the property suite requires,
// while each iteration touches the database a handful of times.
const RUNS = 100;

// The five valid operations the property enumerates, plus the unknown-token
// sign-out that must also be a no-op 204.
type Op = 'resolve' | 'expire' | 'revoke' | 'signOut' | 'resolveAgain';

const op: fc.Arbitrary<Op> = fc.constantFrom(
   'resolve',
   'expire',
   'revoke',
   'signOut',
   'resolveAgain'
);

// A randomized sequence of operations in a valid order — any order is valid,
// because the terminal states (expired/revoked) are absorbing and the property
// asserts the invariant that holds regardless of ordering.
const operations = fc.array(op, { minLength: 1, maxLength: 8 });

// A token that matches no stored session: 43 url-safe chars, the issued shape,
// but never persisted. Used for the unknown-token sign-out no-op.
const TOKEN_CHARS =
   'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.split('');

const unknownToken = fc
   .array(fc.constantFrom(...TOKEN_CHARS), { minLength: 43, maxLength: 43 })
   .map((chars) => chars.join(''));

describe('sessions lifecycle', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let sessions: SessionService;
   const email = `session-lifecycle-${Date.now()}@berry.test`;
   let userId: string;

   before(async () => {
      sql = openDatabase({ url: url as string });
      const [row] = await sql`
         INSERT INTO users (email, name, role) VALUES (${email}, 'Lifecycle Test', 'member')
         RETURNING id`;
      userId = (row as { id: string }).id;
      // A comfortably in-range TTL (60 s) for the live-resolve steps.
      sessions = new SessionService({ sql, sessionTtlMs: 60_000 });
   });

   after(async () => {
      await sql`DELETE FROM sessions WHERE user_id = ${userId}`;
      await sql`DELETE FROM users WHERE id = ${userId}`;
      await closeDatabase(sql);
   });

   async function lastUsedAt(token: string): Promise<number | null> {
      const [row] = await sql`
         SELECT last_used_at FROM sessions WHERE token_hash = ${hashToken(token)}`;
      const value = (row as { last_used_at: string | null } | undefined)?.last_used_at ?? null;
      return value === null ? null : new Date(value).getTime();
   }

   async function expectRejected(token: string): Promise<void> {
      await assert.rejects(
         () => sessions.resolveSession(token),
         SessionUnauthenticated,
         'a dead session must resolve to the 401-equivalent'
      );
   }

   async function expectResolvesTo(token: string, user: User): Promise<void> {
      const resolved = await sessions.resolveSession(token);
      assert.equal(resolved.id, user.id, 'a live resolve must return the issuing user');
      assert.equal(resolved.email, user.email);
   }

   test(
      'Feature: auth-and-tenant-isolation, Property 7: Session lifecycle round-trip — issue, resolve, revoke, stay rejected',
      async () => {
         await fc.assert(
            fc.asyncProperty(operations, unknownToken, async (ops, orphan) => {
               // Each run gets its own freshly issued session so runs do not
               // interfere through the shared user's session table.
               const issued = await sessions.issueKnownEmail(email);
               const token = issued.token;

               // An unknown-token sign-out is a 204 no-op, before touching the
               // live session at all.
               await sessions.revokeSession(orphan);

               // `dead` latches once the session is expired or revoked; from
               // that point every resolve must fail and stay failing.
               let dead = false;

               for (const step of ops) {
                  switch (step) {
                     case 'resolve':
                     case 'resolveAgain': {
                        if (dead) {
                           await expectRejected(token);
                           break;
                        }
                        const before = await lastUsedAt(token);
                        // A resolve stamps last_used_at; a Date is
                        // millisecond-resolution, so the clock must actually
                        // advance between reads for a strict comparison to be
                        // meaningful.
                        await sleepPastMs();
                        await expectResolvesTo(token, issued.user);
                        const after = await lastUsedAt(token);
                        assert.ok(after !== null, 'a live resolve must set last_used_at');
                        if (before !== null) {
                           assert.ok(
                              after > before,
                              'a live resolve must strictly advance last_used_at'
                           );
                        }
                        break;
                     }

                     case 'expire': {
                        // Age this exact session out by pushing its expiry into
                        // the past; storage — the `expires_at > now` guard in
                        // resolveSession — then rejects it on the next resolve.
                        // (This is what a passed clock produces at issue time;
                        // the token itself cannot be re-minted after the fact.)
                        await sql`
                           UPDATE sessions
                              SET expires_at = now() - interval '1 minute'
                            WHERE token_hash = ${hashToken(token)}`;
                        dead = true;
                        await expectRejected(token);
                        break;
                     }

                     case 'revoke': {
                        await sessions.revokeSession(token);
                        dead = true;
                        await expectRejected(token);
                        break;
                     }

                     case 'signOut': {
                        // Sign-out is revocation: a 204 for a known token, and
                        // the session stops resolving afterward.
                        await sessions.revokeSession(token);
                        dead = true;
                        await expectRejected(token);
                        break;
                     }
                  }
               }

               // Whatever the sequence, a final resolve agrees with the latched
               // state: live returns the user, dead stays rejected.
               if (dead) await expectRejected(token);
               else await expectResolvesTo(token, issued.user);
            }),
            { numRuns: RUNS }
         );
      }
   );
});

/**
 * Yields for just over a millisecond so a subsequent `now()` reads a strictly
 * greater timestamp than the previous stamp — `last_used_at` is millisecond
 * resolution over the wire.
 */
async function sleepPastMs(): Promise<void> {
   await new Promise((resolve) => setTimeout(resolve, 2));
}
