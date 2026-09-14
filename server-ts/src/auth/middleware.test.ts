import assert from 'node:assert/strict';
import { test } from 'node:test';

import fc from 'fast-check';
import { Hono } from 'hono';

import { createApp } from '../http/app.ts';
import { Registry } from '../http/registry.ts';
import { requireRole, requireSession, type AuthVariables } from './middleware.ts';
import { CrossOriginRefused, type SessionService, type User } from './sessions.ts';

/**
 * The guarantees Berry leans on for `requireSession`, whatever the credential:
 * the resolved user is on the context before the handler, every failure is
 * the byte-identical 401 envelope, a resolution throw of any kind (a database
 * blip included) is a 401 and never a 500, the handler never runs on a
 * failure, and a cross-origin cookie write is a 403. Offline: `resolveRequest`
 * is a stub.
 */

const USER: User = {
   id: '11111111-1111-1111-1111-111111111111',
   email: 'ada@berry.test',
   name: 'Ada',
   avatarUrl: null,
   role: 'member',
   currentWorkspaceId: null,
   createdAt: '2024-01-01T00:00:00Z',
   updatedAt: '2024-01-01T00:00:00Z',
};

function harness(resolve: (request: Request) => Promise<User>, roles: string[] = []) {
   let ran = false;
   let seen: User | undefined;
   const sessions = { resolveRequest: resolve } as unknown as SessionService;
   const route = new Hono<{ Variables: AuthVariables }>();
   route.use('*', requireSession(sessions));
   if (roles.length > 0) route.use('*', requireRole(...roles));
   route.all('/', (context) => {
      ran = true;
      seen = context.get('user');
      return context.json({ ok: true });
   });
   const registry = new Registry();
   registry.register({ prefix: '/probe', handler: route });
   const app = createApp(registry);
   return {
      fetch: (init: RequestInit = {}) =>
         Promise.resolve(
            app.request('/probe', {
               ...init,
               headers: {
                  'x-request-id': 'req_fixedfixedfixed',
                  ...((init.headers as Record<string, string> | undefined) ?? {}),
               },
            })
         ),
      ran: () => ran,
      seen: () => seen,
   };
}

test('a resolved user is on the context before the handler runs', async () => {
   const probe = harness(async () => USER);
   const response = await probe.fetch();
   assert.equal(response.status, 200);
   assert.equal(probe.seen()?.id, USER.id);
});

test('every kind of resolution failure is the same 401, and the handler never runs', async () => {
   const failures: Array<() => Promise<User>> = [
      async () => {
         throw new Error('unauthenticated');
      },
      async () => {
         throw new Error('connection terminated unexpectedly');
      },
      async () => {
         throw new TypeError('boom');
      },
   ];
   const bodies = new Set<string>();
   for (const fail of failures) {
      const probe = harness(fail);
      const response = await probe.fetch();
      assert.equal(response.status, 401);
      bodies.add(await response.text());
      assert.equal(probe.ran(), false);
   }
   assert.equal(bodies.size, 1, 'the 401 bodies are byte-identical');
   assert.match([...bodies][0] ?? '', /"code":"UNAUTHENTICATED"/);
});

test('a cross-origin cookie write is a 403, not a 401', async () => {
   const probe = harness(async () => {
      throw new CrossOriginRefused();
   });
   const response = await probe.fetch({ method: 'POST' });
   assert.equal(response.status, 403);
   assert.equal(probe.ran(), false);
});

test('whatever the headers, a refusing resolver yields the identical 401', async () => {
   const reference = await (
      await harness(async () => {
         throw new Error('x');
      }).fetch()
   ).text();
   await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 80 }), async (value) => {
         const probe = harness(async () => {
            throw new Error('refused');
         });
         const headers: Record<string, string> = {};
         try {
            new Headers({ authorization: value });
            headers.authorization = value;
         } catch {
            // Not a legal header value; the client could not have sent it.
         }
         const response = await probe.fetch({ headers });
         assert.equal(response.status, 401);
         assert.equal(await response.text(), reference);
      }),
      { numRuns: 100 }
   );
});

test('requireRole refuses a user without the role', async () => {
   const probe = harness(async () => USER, ['admin']);
   const response = await probe.fetch();
   assert.equal(response.status, 403);
   assert.equal(probe.ran(), false);
});
