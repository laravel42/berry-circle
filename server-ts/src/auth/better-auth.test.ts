import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, test } from 'node:test';

import pg from 'pg';

import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { createBerryAuth, devSessionCookies, type BerryAuth } from './better-auth.ts';

/**
 * Better Auth against the real schema. Gated like every database test: without
 * BERRY_TEST_DATABASE_URL this skips and the default suite stays offline.
 * The test database needs migration 150.
 *
 * GitHub is never contacted. Better Auth reaches GitHub with the global
 * `fetch`, so the three GitHub endpoints are answered by a stub for the length
 * of each OAuth test and every other URL is refused, so a surprise call fails
 * loudly instead of reaching the network.
 */

const url = process.env.BERRY_TEST_DATABASE_URL;
const BASE = 'http://localhost:3000';

interface GitHubFixture {
   id: number;
   email: string;
   verified: boolean;
}

function stubGitHub(fixture: GitHubFixture): () => void {
   const original = globalThis.fetch;
   globalThis.fetch = (async (input: string | URL | Request) => {
      const target =
         typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const reply = (body: unknown) =>
         new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
         });
      if (target.startsWith('https://github.com/login/oauth/access_token')) {
         return reply({
            access_token: 'gho_test',
            token_type: 'bearer',
            scope: 'read:user,user:email',
         });
      }
      if (target === 'https://api.github.com/user/emails') {
         return reply([
            { email: fixture.email, primary: true, verified: fixture.verified, visibility: 'public' },
         ]);
      }
      if (target === 'https://api.github.com/user') {
         return reply({
            id: fixture.id,
            login: 'ada-gh',
            name: 'Ada GitHub',
            email: null,
            avatar_url: `https://avatars.githubusercontent.com/u/${fixture.id}`,
         });
      }
      throw new Error(`unexpected fetch in test: ${target}`);
   }) as typeof fetch;
   return () => {
      globalThis.fetch = original;
   };
}

function cookieHeader(response: Response): string {
   return response.headers
      .getSetCookie()
      .map((cookie) => cookie.split(';')[0])
      .join('; ');
}

/** Drives the full GitHub round trip through Better Auth's own handler. */
async function signInWithGitHub(auth: BerryAuth): Promise<Response> {
   const start = await auth.handler(
      new Request(`${BASE}/api/auth/sign-in/social`, {
         method: 'POST',
         headers: { 'content-type': 'application/json', origin: BASE },
         body: JSON.stringify({
            provider: 'github',
            callbackURL: `${BASE}/`,
            errorCallbackURL: `${BASE}/sign-in`,
         }),
      })
   );
   assert.equal(start.status, 200, await start.clone().text());
   const { url: authorize } = (await start.json()) as { url: string };
   const state = new URL(authorize).searchParams.get('state');
   assert.ok(state, 'the authorize URL carries a state');

   return auth.handler(
      new Request(
         `${BASE}/api/auth/callback/github?code=test-code&state=${encodeURIComponent(state)}`,
         { headers: { cookie: cookieHeader(start) } }
      )
   );
}

describe('Better Auth on the users table', { skip: !url }, () => {
   let sql: Sql;
   let pool: pg.Pool;
   let auth: BerryAuth;
   const created: string[] = [];

   before(() => {
      sql = openDatabase({ url: url! });
      pool = new pg.Pool({ connectionString: url, max: 2 });
      auth = createBerryAuth({
         pool,
         secret: 'test-secret-that-is-at-least-32-characters',
         baseUrl: BASE,
         trustedOrigins: [BASE],
         github: { clientId: 'test-client', clientSecret: 'test-secret' },
         sessionTtlMs: 60 * 60 * 1000,
         testUtils: true,
      });
   });

   afterEach(async () => {
      // auth_sessions and auth_accounts cascade from users.
      for (const id of created.splice(0)) await sql`DELETE FROM users WHERE id = ${id}`;
   });

   after(async () => {
      await pool.end();
      await closeDatabase(sql);
   });

   async function existingUser(email: string): Promise<string> {
      const id = randomUUID();
      await sql`INSERT INTO users (id, email, name) VALUES (${id}, ${email}, 'Existing')`;
      created.push(id);
      return id;
   }

   test('a session minted for an existing user resolves to the same users.id', async () => {
      const id = await existingUser(`keep-${randomUUID()}@berry.test`);
      const cookies = await devSessionCookies(auth, id);
      assert.ok(cookies.some((cookie) => cookie.startsWith('berry.session_token=')));
      const session = await auth.api.getSession({
         headers: new Headers({ cookie: cookies.map((c) => c.split(';')[0]).join('; ') }),
      });
      assert.equal(session?.user.id, id);
      const [row] = await sql`SELECT count(*)::int AS n FROM auth_sessions WHERE user_id = ${id}`;
      assert.equal(row?.n, 1);
   });

   test('a GitHub account with a verified email links to the existing user', async () => {
      const email = `link-${randomUUID()}@berry.test`;
      const id = await existingUser(email);
      const restore = stubGitHub({ id: 4242001, email, verified: true });
      try {
         const callback = await signInWithGitHub(auth);
         assert.equal(callback.status, 302);
         assert.equal(callback.headers.get('location'), `${BASE}/`);
         assert.match(callback.headers.getSetCookie().join('\n'), /berry\.session_token=/);
      } finally {
         restore();
      }
      const accounts = await sql`
         SELECT user_id, provider_id, account_id FROM auth_accounts WHERE account_id = '4242001'`;
      assert.equal(accounts.length, 1);
      assert.equal(accounts[0]?.user_id, id);
      assert.equal(accounts[0]?.provider_id, 'github');
      const users = await sql`SELECT id FROM users WHERE lower(email) = ${email}`;
      assert.equal(users.length, 1, 'no second user was created');
   });

   test('an unverified GitHub email neither links nor signs in', async () => {
      const email = `unverified-${randomUUID()}@berry.test`;
      const id = await existingUser(email);
      const restore = stubGitHub({ id: 4242002, email, verified: false });
      let callback: Response;
      try {
         callback = await signInWithGitHub(auth);
      } finally {
         restore();
      }
      assert.equal(callback.status, 302);
      const location = new URL(callback.headers.get('location') ?? '', BASE);
      assert.equal(location.pathname, '/sign-in');
      assert.ok(location.searchParams.get('error'), 'the error code is on the redirect');
      assert.doesNotMatch(callback.headers.getSetCookie().join('\n'), /berry\.session_token=[^;]+/);
      const accounts = await sql`SELECT 1 FROM auth_accounts WHERE user_id = ${id}`;
      assert.equal(accounts.length, 0);
   });

   test('an unverified GitHub email never creates a new Berry user', async () => {
      // No existing user: this is the sign-up path, which account linking does
      // not guard. Only the create hook in better-auth.ts refuses it.
      const email = `new-unverified-${randomUUID()}@berry.test`;
      const restore = stubGitHub({ id: 4242003, email, verified: false });
      let callback: Response;
      try {
         callback = await signInWithGitHub(auth);
      } finally {
         restore();
      }
      assert.equal(callback.status, 302);
      const location = new URL(callback.headers.get('location') ?? '', BASE);
      assert.equal(location.pathname, '/sign-in');
      assert.doesNotMatch(callback.headers.getSetCookie().join('\n'), /berry\.session_token=[^;]+/);
      const users = await sql`SELECT id FROM users WHERE lower(email) = ${email}`;
      for (const row of users) created.push(row.id as string);
      assert.equal(users.length, 0, 'no user was created from an unverified address');
      const accounts = await sql`SELECT 1 FROM auth_accounts WHERE account_id = '4242003'`;
      assert.equal(accounts.length, 0);
   });

   test('email and password sign-up is not served', async () => {
      const response = await auth.handler(
         new Request(`${BASE}/api/auth/sign-up/email`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: BASE },
            body: JSON.stringify({
               email: 'x@berry.test',
               password: 'long-enough-password',
               name: 'x',
            }),
         })
      );
      assert.ok(response.status >= 400, `expected a refusal, got ${response.status}`);
   });
});
