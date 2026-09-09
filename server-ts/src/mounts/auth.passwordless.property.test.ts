// Feature: auth-and-tenant-isolation, Property 13: Passwordless login
// availability is exactly the environment-and-flag truth table.
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
 * The property drives `POST /api/v1/auth/login` — the known-email passwordless
 * affordance — end to end through the real app shell for every combination of
 * environment, flag, and target. `loginAllowed` (auth.ts) opens the route only
 * when `allowKnownEmail` is set AND the environment is `development` or `test`;
 * every other combination throws `ApiError.routeNotFound()`. When the route is
 * open, an existing address is issued a session and an unknown one is refused
 * with the uniform invalid-credentials envelope, minting nothing.
 *
 * Wire-code note: the design names the closed-gate outcome "ROUTE_NOT_FOUND",
 * but `ApiError.routeNotFound()` emits status 404 with code `NOT_FOUND` on the
 * wire (errors.ts). The assertions check the bytes the client actually sees —
 * 404 + `NOT_FOUND` — which is the contract Property 13 is really about.
 */

const url = process.env.BERRY_TEST_DATABASE_URL;

// Each iteration builds a mount and drives a real HTTP request against
// Postgres, so hold the run at the ≥100 floor the property suite requires.
const RUNS = 100;

const SESSION_TTL_MS = 172_800_000;

// A namespace unique to this run's process so cleanup never touches a row it
// did not write. Emails collide case-insensitively (users_email_ci_key), so the
// prefix is lowercase.
const NAMESPACE = `p13-${Date.now().toString(36)}-${process.pid.toString(36)}`.toLowerCase();

/**
 * The environment axis: the two that open the route plus three that never do
 * (a real deploy target, a staging target, and an arbitrary string). The gate
 * lowercases and trims, so casing is not what decides availability.
 */
const environment = fc.constantFrom<string>(
   'development',
   'test',
   'production',
   'staging',
   'random-environment-string'
);

/** The `AUTH_ALLOW_PASSWORDLESS_LOGIN` flag axis. */
const flag = fc.boolean();

/** The target axis: the seeded existing address, or a never-registered one. */
const target = fc.constantFrom<'existing' | 'unknown'>('existing', 'unknown');

/** The oracle: the route is open only in a dev/test environment with the flag. */
function isAvailable(env: string, on: boolean): boolean {
   const normalized = env.trim().toLowerCase();
   return on && (normalized === 'development' || normalized === 'test');
}

describe(
   'Feature: auth-and-tenant-isolation, Property 13: Passwordless login availability is exactly the environment-and-flag truth table',
   { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' },
   () => {
      let sql: Sql;
      const existingEmail = `${NAMESPACE}-existing@berry.test`;
      // A well-formed address that is never inserted, so "available + unknown
      // target" exercises the invalid-credentials path rather than a lookup hit.
      const unknownEmail = `${NAMESPACE}-unknown@berry.test`;
      let userId: string;

      before(async () => {
         sql = openDatabase({ url: url as string });
         const [row] = await sql`
            INSERT INTO users (email, name, role)
            VALUES (${existingEmail}, 'Passwordless Property 13', 'member')
            RETURNING id`;
         userId = (row as { id: string }).id;
      });

      after(async () => {
         // Sessions cascade on user delete; remove the seeded account and any
         // session minted for it goes with it. The unknown address was never
         // inserted, so there is nothing else to clean up.
         await sql`DELETE FROM users WHERE id = ${userId}`;
         await closeDatabase(sql);
      });

      /** Build the real app with auth mounts wired to the given login config. */
      const buildApp = (env: string, on: boolean): BerryApp => {
         const registry = new Registry();
         registry.registerAll(
            authMounts({
               sessions: new SessionService({ sql, sessionTtlMs: SESSION_TTL_MS }),
               identity: new IdentityRepository(sql),
               sql,
               login: { allowKnownEmail: on, environment: env },
            })
         );
         return createApp(registry);
      };

      const login = (app: BerryApp, email: string) =>
         app.request('/api/v1/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email }),
         });

      /** How many session rows currently exist for a given user id. */
      const sessionCount = async (id: string): Promise<number> => {
         const [row] = await sql`SELECT count(*)::int AS n FROM sessions WHERE user_id = ${id}`;
         return (row as { n: number }).n;
      };

      test(
         'Feature: auth-and-tenant-isolation, Property 13: /login is reachable iff env ∈ {development,test} ∧ flag; otherwise 404 NOT_FOUND; available + unknown target is invalid-credentials with no session',
         async () => {
            await fc.assert(
               fc.asyncProperty(
                  environment,
                  flag,
                  target,
                  async (env, on, which) => {
                     const app = buildApp(env, on);
                     const email = which === 'existing' ? existingEmail : unknownEmail;
                     const available = isAvailable(env, on);

                     const response = await login(app, email);

                     if (!available) {
                        // Closed gate: 404 NOT_FOUND regardless of the target,
                        // and no session is ever issued for the seeded user.
                        assert.equal(
                           response.status,
                           404,
                           `env=${env} flag=${on} target=${which}: closed gate must be a 404`
                        );
                        const body = (await response.json()) as { error: { code: string } };
                        assert.equal(
                           body.error.code,
                           'NOT_FOUND',
                           'a closed gate carries the route-not-found code'
                        );
                        assert.equal(
                           await sessionCount(userId),
                           0,
                           'a closed gate issues no session'
                        );
                        return;
                     }

                     if (which === 'existing') {
                        // Open gate + existing target: a session is issued and
                        // its token resolves back to the seeded user.
                        assert.equal(
                           response.status,
                           200,
                           `env=${env} flag=${on}: an existing target must be issued a session`
                        );
                        const payload = (await response.json()) as { token?: unknown };
                        assert.equal(
                           typeof payload.token,
                           'string',
                           'a 200 must carry a token string'
                        );
                        assert.equal(
                           await sessionCount(userId),
                           1,
                           'exactly one session exists after an accepted login'
                        );
                        // Keep the sessions table bounded across ≥100 iterations.
                        await sql`DELETE FROM sessions WHERE user_id = ${userId}`;
                     } else {
                        // Open gate + unknown target: the uniform invalid-
                        // credentials envelope (401 UNAUTHENTICATED) and no
                        // session row for the unknown address.
                        assert.equal(
                           response.status,
                           401,
                           `env=${env} flag=${on}: an unknown target must be refused`
                        );
                        const body = (await response.json()) as { error: { code: string } };
                        assert.equal(
                           body.error.code,
                           'UNAUTHENTICATED',
                           'an unknown target gets the invalid-credentials code'
                        );
                        // The unknown address maps to no user, so no session can
                        // reference it; the seeded user is likewise untouched.
                        const [row] = await sql`
                           SELECT count(*)::int AS n
                             FROM sessions s
                             JOIN users u ON u.id = s.user_id
                            WHERE lower(u.email) = lower(${unknownEmail})`;
                        assert.equal(
                           (row as { n: number }).n,
                           0,
                           'a refused unknown target creates no session'
                        );
                        assert.equal(
                           await sessionCount(userId),
                           0,
                           'a refused login leaves the seeded user with no session'
                        );
                     }
                  }
               ),
               { numRuns: RUNS }
            );
         }
      );
   }
);
