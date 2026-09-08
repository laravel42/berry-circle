// Feature: auth-and-tenant-isolation, Property 9: Sign-in credential outcomes
// are indistinguishable across failure kinds.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import fc from 'fast-check';

import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { hashPassword } from '../auth/password.ts';
import { SessionService } from '../auth/sessions.ts';
import { createApp } from '../http/app.ts';
import { Registry } from '../http/registry.ts';
import { IdentityRepository } from '../identity/repository.ts';
import { authMounts } from './auth.ts';

/**
 * Database-backed property test, gated the way the rest of the suite gates its
 * own: `BERRY_TEST_DATABASE_URL` against a database carrying the real
 * migrations. Without it this skips, so the default suite stays offline.
 *
 *   createdb berry_ts_test
 *   psql berry_ts_test < <(pg_dump --schema-only berry)
 *   BERRY_TEST_DATABASE_URL=postgres://... npm test
 *
 * The property: sign-in is exercised end-to-end through the real mount against
 * a registered user. A correct credential returns 200 with a token that
 * resolves back to that user; a wrong password and an unknown email both return
 * a 401, and those two failures are byte-identical — same status, same JSON
 * body, same relevant headers. Distinguishing them would tell a caller which
 * addresses exist (Requirements 1.1–1.4).
 */

const url = process.env.BERRY_TEST_DATABASE_URL;

// Each iteration drives a real HTTP request through the app against Postgres —
// and the failure kinds each run a deliberately-slow scrypt derivation — so
// hold the run at the ≥100 floor the property suite requires.
const RUNS = 100;

// A fixed in-range TTL (300..2,592,000 seconds), well inside the window.
const TTL_MS = 172_800_000;

// The known password of the seeded user. >= 12 chars to satisfy the sign-in
// body policy so a correct attempt reaches credential verification.
const KNOWN_PASSWORD = 'correct horse battery staple';

// A client-supplied correlation id is echoed verbatim by the app when it is
// safe (isValidRequestId). Pinning it to the same value on both failure
// requests removes the only per-request-random field from the envelope, so any
// remaining difference between the two 401 bodies is a real credential-oracle
// leak rather than noise. The request id is caller-controlled correlation, not
// a signal about the credential.
const FIXED_REQUEST_ID = 'req_property9indistinguishability';

/** Build the real app with just the auth mounts wired to the live database. */
function buildApp(sql: Sql) {
   const sessions = new SessionService({ sql, sessionTtlMs: TTL_MS });
   const identity = new IdentityRepository(sql);
   const registry = new Registry();
   registry.registerAll(
      authMounts({
         sessions,
         identity,
         sql,
         login: { allowKnownEmail: false, environment: 'test' },
      })
   );
   return { app: createApp(registry), sessions };
}

/** POST a sign-in body, optionally forcing the correlation id. */
function signIn(
   app: ReturnType<typeof buildApp>['app'],
   body: unknown,
   requestId?: string
): Promise<Response> {
   const headers: Record<string, string> = { 'content-type': 'application/json' };
   if (requestId !== undefined) headers['x-request-id'] = requestId;
   return Promise.resolve(
      app.request('/api/v1/auth/sign-in', {
         method: 'POST',
         headers,
         body: JSON.stringify(body),
      })
   );
}

/**
 * The response facets Property 9 compares across the two failure kinds: status,
 * the exact body bytes, and the headers a client can observe. `x-request-id` is
 * pinned identical by the caller, so it is included rather than stripped.
 */
async function snapshot(response: Response) {
   const headers = [...response.headers.entries()]
      .map(([name, value]) => [name.toLowerCase(), value] as const)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
   return {
      status: response.status,
      body: await response.text(),
      headers,
   };
}

describe(
   'Feature: auth-and-tenant-isolation, Property 9: Sign-in credential outcomes are indistinguishable across failure kinds',
   { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' },
   () => {
      let sql: Sql;
      const knownEmail = `signin-property9-${Date.now()}@berry.test`;
      let userId: string;

      before(async () => {
         sql = openDatabase({ url: url as string });
         const stored = await hashPassword(KNOWN_PASSWORD);
         const [row] = await sql`
            INSERT INTO users (email, name, role, password_hash, password_salt, password_updated_at)
            VALUES (${knownEmail}, 'Sign-in Property 9', 'member',
                    ${stored.hash}, ${stored.salt}, now())
            RETURNING id`;
         userId = (row as { id: string }).id;
      });

      after(async () => {
         await sql`DELETE FROM sessions WHERE user_id = ${userId}`;
         await sql`DELETE FROM users WHERE id = ${userId}`;
         await closeDatabase(sql);
      });

      test(
         'Feature: auth-and-tenant-isolation, Property 9: correct → 200 with a resolvable token; wrong password and unknown email → byte-identical 401 envelopes',
         async () => {
            const { app, sessions } = buildApp(sql);

            await fc.assert(
               // A random wrong password (still policy-valid so it reaches
               // verification, not the 422 shape gate) and a random unknown but
               // well-formed address. The correct attempt always uses the
               // seeded credential.
               fc.asyncProperty(
                  fc
                     .string({ minLength: 12, maxLength: 64 })
                     .filter((candidate) => candidate !== KNOWN_PASSWORD),
                  fc
                     .string({ minLength: 1, maxLength: 24 })
                     .map((local) => local.replace(/[^a-z0-9]/gi, '') || 'nobody')
                     .map((local) => `${local}-${Math.random().toString(36).slice(2)}@absent.test`),
                  async (wrongPassword, unknownEmail) => {
                     // correct → 200 and a token that resolves to this user.
                     const correct = await signIn(app, {
                        email: knownEmail,
                        password: KNOWN_PASSWORD,
                     });
                     assert.equal(correct.status, 200, 'a correct credential must be accepted');
                     const payload = (await correct.json()) as { token?: unknown };
                     assert.equal(
                        typeof payload.token,
                        'string',
                        'a 200 must carry a token string'
                     );
                     const resolved = await sessions.resolveSession(payload.token as string);
                     assert.equal(
                        resolved.id,
                        userId,
                        'the issued token must resolve back to the signed-in user'
                     );

                     // wrongPassword and unknownEmail → both 401, byte-identical.
                     const wrong = await snapshot(
                        await signIn(
                           app,
                           { email: knownEmail, password: wrongPassword },
                           FIXED_REQUEST_ID
                        )
                     );
                     const unknown = await snapshot(
                        await signIn(
                           app,
                           { email: unknownEmail, password: KNOWN_PASSWORD },
                           FIXED_REQUEST_ID
                        )
                     );

                     assert.equal(wrong.status, 401, 'a wrong password must be a 401');
                     assert.equal(unknown.status, 401, 'an unknown email must be a 401');
                     assert.deepEqual(
                        wrong,
                        unknown,
                        'wrong-password and unknown-email 401s must be indistinguishable ' +
                           '(same status, body bytes, and headers)'
                     );
                  }
               ),
               { numRuns: RUNS }
            );
         }
      );
   }
);
