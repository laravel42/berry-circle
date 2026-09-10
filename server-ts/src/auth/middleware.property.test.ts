import assert from 'node:assert/strict';
import { test } from 'node:test';
import fc from 'fast-check';

import { Hono } from 'hono';
import { closeDatabase, openDatabase } from '../db/pool.ts';
import { createApp } from '../http/app.ts';
import { Registry } from '../http/registry.ts';
import { requireSession, type AuthVariables } from './middleware.ts';
import { SessionService, SessionUnauthenticated, type User } from './sessions.ts';
import { generateToken } from './tokens.ts';

/**
 * Property 1 — Unauthenticated and malformed credentials are uniformly rejected.
 *
 * For *any* request to a protected endpoint whose credential is absent,
 * wrong-scheme, empty, whitespace-only, non-printable, over-long, duplicated
 * across two Authorization headers, or well-formed-but-unknown, the response is
 * a byte-for-byte identical `401 UNAUTHENTICATED` envelope (same status, body,
 * and headers) and the route handler is never invoked.
 *
 * This mirrors the unit suite's harness (task 8.2) — `requireSession` mounted on
 * the real `createApp` shell behind a sentinel handler that records whether it
 * ran, with `resolveCredential` stubbed — and drives it with fast-check over the
 * eight credential categories.
 *
 * It is deliberately offline. The stub resolver throws `SessionUnauthenticated`
 * for every token, which is exactly the shape the real service takes for an
 * expired, revoked, or unknown session, so `unknownButWellFormed` is faithfully
 * modelled without a database. A DB-backed variant is added at the end, gated on
 * `BERRY_TEST_DATABASE_URL`, so a fresh offline `pnpm test:server` stays green.
 */

/** A well-formed 256-bit session token, so parsing is never the thing failing. */
const GOOD_TOKEN = generateToken();

/** The eight credential categories from the design's generator. */
const CATEGORIES = [
   'absent',
   'wrongScheme',
   'empty',
   'whitespace',
   'nonPrintable',
   'tooLong',
   'duplicateHeader',
   'unknownButWellFormed',
] as const;

type Category = (typeof CATEGORIES)[number];

/**
 * A `SessionService` whose only behaviour under test is `resolveCredential`.
 * The middleware touches nothing else, so the cast is the seam that lets the
 * stub stand in for the real service.
 */
function fakeSessions(resolve: (token: string) => Promise<User>): SessionService {
   return { resolveCredential: resolve } as unknown as SessionService;
}

/**
 * Mounts `requireSession` on the real app shell behind a sentinel handler. Using
 * `createApp` means the error envelope, request id, and standard headers are the
 * real ones, so a byte comparison is a comparison of what a client receives.
 */
function harness(resolve: (token: string) => Promise<User>): {
   fetch: (headers: Headers) => Promise<Response>;
   handlerRan: () => boolean;
} {
   let ran = false;

   const route = new Hono<{ Variables: AuthVariables }>();
   route.use('*', requireSession(fakeSessions(resolve)));
   route.get('/', (context) => {
      ran = true;
      return context.json({ ok: true });
   });

   const registry = new Registry();
   registry.register({ prefix: '/guarded', handler: route });
   const app = createApp(registry);

   return {
      fetch: (headers) => Promise.resolve(app.request('/guarded', { headers })),
      handlerRan: () => ran,
   };
}

/**
 * Everything a client can observe: status, the exact body bytes, and every
 * response header sorted so ordering is not what a comparison trips over.
 */
async function snapshot(response: Response): Promise<{
   status: number;
   body: string;
   headers: Array<[string, string]>;
}> {
   const headers = [...response.headers.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
   return { status: response.status, body: await response.text(), headers };
}

/**
 * Builds the Authorization header(s) for a category from a random token body.
 * `duplicateHeader` returns two values on the same name; the rest are a single
 * header, or none at all for `absent`. A fixed `x-request-id` is pinned so the
 * `X-Request-Id` header — and thus the whole envelope — is deterministic and
 * comparable across categories.
 */
function headersFor(category: Category, body: string): Headers {
   const headers = new Headers();
   headers.set('x-request-id', 'fixed-request-id');

   switch (category) {
      case 'absent':
         break;
      case 'wrongScheme':
         headers.set('authorization', `Basic ${GOOD_TOKEN}`);
         break;
      case 'empty':
         headers.set('authorization', '');
         break;
      case 'whitespace':
         headers.set('authorization', '   ');
         break;
      case 'nonPrintable':
         // A control character inside an otherwise Bearer-shaped credential.
         headers.set('authorization', `Bearer ${body}\u0001${body}`);
         break;
      case 'tooLong':
         // Longer than the 4096-character ceiling the design names.
         headers.set('authorization', `Bearer ${'a'.repeat(5000)}`);
         break;
      case 'duplicateHeader':
         headers.append('authorization', `Bearer ${GOOD_TOKEN}`);
         headers.append('authorization', `Bearer ${body || 'b'.repeat(43)}`);
         break;
      case 'unknownButWellFormed':
         // A syntactically valid token the resolver will not recognise.
         headers.set('authorization', `Bearer ${GOOD_TOKEN}`);
         break;
   }
   return headers;
}

test('Feature: auth-and-tenant-isolation, Property 1: Unauthenticated and malformed credentials are uniformly rejected', async () => {
   // The reference envelope every category must match byte-for-byte. Captured
   // from the first category so the assertion is "all equal", not "all match a
   // hand-written constant".
   let reference: Awaited<ReturnType<typeof snapshot>> | undefined;

   await fc.assert(
      fc.asyncProperty(
         fc.constantFrom(...CATEGORIES),
         // A random token body feeds the categories that use one; ignored by
         // the rest. Kept to base64url-ish bytes so it is a plausible credential.
         fc.string({ minLength: 0, maxLength: 64 }),
         async (category, body) => {
            // Every token is rejected — the shape the real service takes for an
            // expired, revoked, or unknown session. Parsing rejects the malformed
            // categories earlier, so this only fires for unknownButWellFormed.
            const app = harness(async () => {
               throw new SessionUnauthenticated();
            });

            const response = await app.fetch(headersFor(category, body));

            // The sentinel handler is never reached.
            assert.equal(app.handlerRan(), false, `handler ran for ${category}`);

            const current = await snapshot(response);
            assert.equal(current.status, 401, `status for ${category}`);

            if (reference === undefined) {
               reference = current;
            } else {
               assert.deepEqual(current, reference, `envelope differs for ${category}`);
            }
         }
      ),
      { numRuns: 200 }
   );

   // Sanity-check the reference is the published UNAUTHENTICATED envelope.
   assert.ok(reference);
   const parsed = JSON.parse(reference.body) as { error: { code: string; message: string } };
   assert.equal(parsed.error.code, 'UNAUTHENTICATED');
   assert.equal(parsed.error.message, 'Authentication required.');
});

/**
 * DB-backed variant of the `unknownButWellFormed` case: a real, well-formed
 * token that matches no row must resolve to the same 401 through the live
 * `SessionService`. Self-skips when `BERRY_TEST_DATABASE_URL` is unset so a
 * fresh offline run stays green.
 */
test('Feature: auth-and-tenant-isolation, Property 1: an unknown well-formed token is rejected against the database', async (t) => {
   const url = process.env.BERRY_TEST_DATABASE_URL;
   if (!url) {
      t.skip('BERRY_TEST_DATABASE_URL is not set');
      return;
   }

   const sql = openDatabase({ url });
   try {
      const sessions = new SessionService({ sql, sessionTtlMs: 300_000 });

      const route = new Hono<{ Variables: AuthVariables }>();
      let ran = false;
      route.use('*', requireSession(sessions));
      route.get('/', (context) => {
         ran = true;
         return context.json({ ok: true });
      });
      const registry = new Registry();
      registry.register({ prefix: '/guarded', handler: route });
      const app = createApp(registry);

      await fc.assert(
         fc.asyncProperty(fc.constant(null), async () => {
            ran = false;
            // A freshly generated token: valid shape, no matching session row.
            const headers = new Headers({
               'x-request-id': 'fixed-request-id',
               authorization: `Bearer ${generateToken()}`,
            });
            const response = await app.request('/guarded', { headers });
            assert.equal(response.status, 401);
            assert.equal(ran, false);
            const body = JSON.parse(await response.text()) as { error: { code: string } };
            assert.equal(body.error.code, 'UNAUTHENTICATED');
         }),
         { numRuns: 100 }
      );
   } finally {
      await closeDatabase(sql);
   }
});
