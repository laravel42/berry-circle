import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createApp } from '../http/app.ts';
import { Registry } from '../http/registry.ts';
import { requireSession, type AuthVariables } from './middleware.ts';
import { SessionUnauthenticated, type SessionService, type User } from './sessions.ts';
import { generateToken } from './tokens.ts';
import { Hono } from 'hono';

/**
 * These assertions pin the five guarantees Berry leans on for `requireSession`:
 * exactly one Bearer credential is admitted, every failure answers with the
 * byte-identical 401 `UNAUTHENTICATED` envelope, the handler never runs on a
 * failure, the resolved `User` is on the context before anything downstream,
 * and a resolution *throw* (a database blip, say) becomes a 401 rather than a
 * 500 that would tell a caller their token was probably real.
 *
 * The suite is deliberately offline: `resolveCredential` is a stub, so it runs
 * on a fresh checkout with no database.
 */

/** A live user the happy path resolves to. */
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

/** A well-formed 256-bit session token, so parsing is never the thing failing. */
const GOOD_TOKEN = generateToken();

/**
 * A `SessionService` whose only behaviour under test is `resolveCredential`.
 * The middleware touches nothing else, so the rest of the class stays absent;
 * the cast is the seam that lets the stub stand in for the real service.
 */
function fakeSessions(resolve: (token: string) => Promise<User>): SessionService {
   return { resolveCredential: resolve } as unknown as SessionService;
}

/**
 * Mounts `requireSession` on the real app shell behind a sentinel handler that
 * records whether it ran. Using `createApp` means the error envelope, request
 * id and standard headers are the real ones, so a byte comparison is a
 * comparison of what a client would actually receive.
 */
function harness(resolve: (token: string) => Promise<User>): {
   fetch: (headers: Record<string, string> | Headers) => Promise<Response>;
   handlerRan: () => boolean;
   seenUser: () => User | undefined;
} {
   let ran = false;
   let user: User | undefined;

   const route = new Hono<{ Variables: AuthVariables }>();
   route.use('*', requireSession(fakeSessions(resolve)));
   route.get('/', (context) => {
      ran = true;
      user = context.get('user');
      return context.json({ ok: true });
   });

   const registry = new Registry();
   registry.register({ prefix: '/guarded', handler: route });
   const app = createApp(registry);

   return {
      fetch: (headers) =>
         Promise.resolve(
            app.request('/guarded', {
               headers: headers instanceof Headers ? headers : new Headers(headers),
            })
         ),
      handlerRan: () => ran,
      seenUser: () => user,
   };
}

/** The bytes and status a client sees for any failed credential. */
async function snapshot(response: Response): Promise<{ status: number; body: string }> {
   return { status: response.status, body: await response.text() };
}

test('a valid credential resolves and reaches the handler with the user attached', async () => {
   const app = harness(async () => USER);
   const response = await app.fetch({ authorization: `Bearer ${GOOD_TOKEN}` });

   assert.equal(response.status, 200);
   assert.equal(app.handlerRan(), true);
   // The resolved User is on the context before the handler runs — the point
   // any WorkspaceContext resolver downstream would read it from.
   assert.deepEqual(app.seenUser(), USER);
});

test('every failure mode returns the byte-identical 401 UNAUTHENTICATED and never runs the handler', async () => {
   // One resolver covers absent/malformed (parsing fails first) and, for a
   // well-formed-but-unknown token, an explicit SessionUnauthenticated — the
   // shape expired/revoked/unknown all take in the real service.
   const scenarios: Array<{ name: string; headers: Record<string, string> | Headers }> = [
      { name: 'absent header', headers: {} },
      { name: 'wrong scheme', headers: { authorization: `Basic ${GOOD_TOKEN}` } },
      { name: 'empty value', headers: { authorization: '' } },
      { name: 'whitespace only', headers: { authorization: '   ' } },
      { name: 'doubled space', headers: { authorization: `Bearer  ${GOOD_TOKEN}` } },
      { name: 'second credential', headers: { authorization: `Bearer ${GOOD_TOKEN} extra` } },
      { name: 'too short', headers: { authorization: 'Bearer short' } },
      { name: 'too long', headers: { authorization: `Bearer ${'a'.repeat(5000)}` } },
      { name: 'not base64url', headers: { authorization: `Bearer !${'a'.repeat(42)}` } },
      { name: 'unknown but well-formed', headers: { authorization: `Bearer ${GOOD_TOKEN}` } },
   ];

   // A duplicate Authorization header: two values, which the middleware must
   // refuse rather than silently take the first. Headers keeps both.
   const duplicate = new Headers();
   duplicate.append('authorization', `Bearer ${GOOD_TOKEN}`);
   duplicate.append('authorization', `Bearer ${'b'.repeat(43)}`);
   scenarios.push({ name: 'duplicate header', headers: duplicate });

   // A fixed request id so the envelope is deterministic and comparable across
   // scenarios; without it each response carries a fresh random id.
   const withRequestId = (headers: Record<string, string> | Headers): Headers => {
      const merged = headers instanceof Headers ? headers : new Headers(headers);
      merged.set('x-request-id', 'fixed-request-id');
      return merged;
   };

   let expected: { status: number; body: string } | undefined;
   for (const scenario of scenarios) {
      // The resolver rejects unknown tokens; parsing rejects the rest earlier.
      const app = harness(async () => {
         throw new SessionUnauthenticated();
      });
      const response = await app.fetch(withRequestId(scenario.headers));

      assert.equal(response.status, 401, scenario.name);
      assert.equal(app.handlerRan(), false, `handler ran for ${scenario.name}`);

      const current = await snapshot(response);
      if (expected === undefined) {
         expected = current;
      } else {
         assert.deepEqual(current, expected, `envelope differs for ${scenario.name}`);
      }
   }

   assert.ok(expected);
   const parsed = JSON.parse(expected.body) as { error: { code: string; message: string } };
   assert.equal(parsed.error.code, 'UNAUTHENTICATED');
   assert.equal(parsed.error.message, 'Authentication required.');
});

test('an unexpected resolution error becomes a 401, never a 500', async () => {
   // A database failure inside resolveCredential must not surface as a 500 that
   // signals the token was likely valid. The middleware catches everything.
   const app = harness(async () => {
      throw new Error('connection reset by peer');
   });
   const response = await app.fetch({ authorization: `Bearer ${GOOD_TOKEN}` });

   assert.equal(response.status, 401);
   assert.equal(app.handlerRan(), false);
   const body = JSON.parse(await response.text()) as { error: { code: string } };
   assert.equal(body.error.code, 'UNAUTHENTICATED');
});
