// Feature: auth-and-tenant-isolation, Property 8: Idempotent creation is a
// replay, and a key reuse with a different body is a conflict.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import fc from 'fast-check';

import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { createApp, type BerryApp } from '../http/app.ts';
import { Registry } from '../http/registry.ts';
import { SessionService } from '../auth/sessions.ts';
import { IdentityRepository } from '../identity/repository.ts';
import { authMounts } from './auth.ts';

/**
 * Database-backed property test, gated the way the rest of the server suite
 * gates its own: `BERRY_TEST_DATABASE_URL` against a database carrying the real
 * migrations. Without it this self-skips, so a fresh `pnpm test:server` stays
 * green offline.
 *
 *   createdb berry_ts_test
 *   psql berry_ts_test < <(pg_dump --schema-only berry)
 *   BERRY_TEST_DATABASE_URL=postgres://... pnpm test:server
 *
 * The property exercises the new surface — `POST /api/v1/auth/sign-up` — end to
 * end through the real app shell so the `Idempotency-Key` header parsing, the
 * repository's `creation_key_hash`/`creation_fingerprint` replay path, and the
 * `IDEMPOTENCY_CONFLICT` error envelope are all covered as one behaviour rather
 * than in isolation. Workspace-create shares the same mechanism; sign-up is the
 * surface added by this feature, so it is the one asserted here.
 */

const url = process.env.BERRY_TEST_DATABASE_URL;

// Each iteration issues real sessions and writes real rows against Postgres, so
// hold the run at the ≥100 floor the property suite requires rather than higher.
const RUNS = 100;

const SESSION_TTL_MS = 172_800_000;

// A namespace unique to this run's process, so the count of "rows this test
// created" is exact even when the table already holds other accounts, and so
// cleanup never touches a row it did not write. Emails collide case-insensitively
// (users_email_ci_key), so the prefix is lowercase.
const NAMESPACE = `p8-${Date.now().toString(36)}-${process.pid.toString(36)}`.toLowerCase();

/** A visible-ASCII value of 16..128 bytes: a valid Idempotency-Key. */
const idempotencyKey = fc
   .array(fc.integer({ min: 0x21, max: 0x7e }), { minLength: 16, maxLength: 64 })
   .map((codes) => codes.map((code) => String.fromCharCode(code)).join(''));

/** A policy-valid password: 12..128 characters. */
const password = fc.string({ minLength: 12, maxLength: 40 });

describe(
   'Feature: auth-and-tenant-isolation, Property 8: Idempotent creation is a replay, and a key reuse with a different body is a conflict',
   { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' },
   () => {
      let sql: Sql;
      let app: BerryApp;

      before(() => {
         sql = openDatabase({ url: url as string });
         const registry = new Registry();
         registry.registerAll(
            authMounts({
               sessions: new SessionService({ sql, sessionTtlMs: SESSION_TTL_MS }),
               identity: new IdentityRepository(sql),
               sql,
               // Sign-up does not depend on the known-email login flag; a fixed
               // config keeps the mount self-contained.
               login: { allowKnownEmail: false, environment: 'test' },
            })
         );
         app = createApp(registry);
      });

      after(async () => {
         // Sessions cascade on user delete; remove the accounts this run created
         // and the sessions minted for them go with them.
         await sql`DELETE FROM users WHERE email LIKE ${NAMESPACE + '-%'}`;
         await closeDatabase(sql);
      });

      // A monotonic counter keeps every generated email distinct within the run,
      // so "no key → a fresh resource" is not defeated by two iterations reusing
      // one address (which would be a taken-email 409, not a fresh account).
      let seq = 0;
      const freshEmail = () => `${NAMESPACE}-${(seq += 1).toString(36)}@berry.test`;

      const countUsers = async (email: string): Promise<number> => {
         const [row] = await sql`SELECT count(*)::int AS n FROM users WHERE email = ${email}`;
         return (row as { n: number }).n;
      };

      const signUp = (email: string, pw: string, key: string | null) =>
         app.request('/api/v1/auth/sign-up', {
            method: 'POST',
            headers: {
               'Content-Type': 'application/json',
               ...(key === null ? {} : { 'Idempotency-Key': key }),
            },
            body: JSON.stringify({ email, password: pw }),
         });

      // The user id a sign-up minted, read back from the session token it
      // returned. Two responses that carry the same user id created no second
      // account; distinct ids are distinct accounts.
      const userIdOf = async (response: Response): Promise<string> => {
         const body = (await response.json()) as { user: { id: string } };
         return body.user.id;
      };

      test(
         'Feature: auth-and-tenant-isolation, Property 8: same key + identical body replays the same account, same key + mutated body is a 409 conflict creating nothing, and no key is always a fresh account',
         async () => {
            await fc.assert(
               fc.asyncProperty(
                  password,
                  password,
                  idempotencyKey,
                  async (pw, otherPw, key) => {
                     // (a) Identical-body replay: the same key with the same body
                     // returns the same account and creates no second row.
                     const emailA = freshEmail();
                     const first = await signUp(emailA, pw, key);
                     assert.equal(first.status, 201, 'first keyed sign-up creates the account');
                     const firstId = await userIdOf(first);
                     const countAfterFirst = await countUsers(emailA);
                     assert.equal(countAfterFirst, 1, 'exactly one account exists after create');

                     const replay = await signUp(emailA, pw, key);
                     assert.equal(replay.status, 201, 'an identical replay is a 201, not a new code');
                     assert.equal(
                        await userIdOf(replay),
                        firstId,
                        'an identical replay returns the same durable account'
                     );
                     assert.equal(
                        await countUsers(emailA),
                        countAfterFirst,
                        'an identical replay creates no second account'
                     );

                     // (b) Mutated-body reuse: the same key with a different body
                     // is a 409 IDEMPOTENCY_CONFLICT and creates nothing. A
                     // different password is enough to change the fingerprint;
                     // guard against the generator handing back an equal pair.
                     const mutatedPw = otherPw === pw ? `${pw}x` : otherPw;
                     const conflict = await signUp(emailA, mutatedPw, key);
                     assert.equal(
                        conflict.status,
                        409,
                        'reusing a key with a different body is a conflict'
                     );
                     const conflictBody = (await conflict.json()) as { error: { code: string } };
                     assert.equal(
                        conflictBody.error.code,
                        'IDEMPOTENCY_CONFLICT',
                        'the conflict carries the IDEMPOTENCY_CONFLICT code'
                     );
                     assert.equal(
                        await countUsers(emailA),
                        countAfterFirst,
                        'a conflicting reuse creates no account'
                     );

                     // (c) No key: every request is processed as new, so two
                     // keyless sign-ups of distinct addresses are two distinct
                     // accounts.
                     const emailB = freshEmail();
                     const emailC = freshEmail();
                     const keyless1 = await signUp(emailB, pw, null);
                     const keyless2 = await signUp(emailC, pw, null);
                     assert.equal(keyless1.status, 201, 'a keyless sign-up creates an account');
                     assert.equal(keyless2.status, 201, 'a second keyless sign-up creates an account');
                     assert.notEqual(
                        await userIdOf(keyless1),
                        await userIdOf(keyless2),
                        'keyless sign-ups of distinct addresses are distinct accounts'
                     );

                     // Keep the table bounded across ≥100 iterations.
                     await sql`DELETE FROM users WHERE email IN (${emailA}, ${emailB}, ${emailC})`;
                  }
               ),
               { numRuns: RUNS }
            );
         }
      );
   }
);
