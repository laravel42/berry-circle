import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Hono } from 'hono';
import { createApp } from '../http/app.ts';
import { Registry } from '../http/registry.ts';
import { requireSession, type AuthVariables } from './middleware.ts';
import { hashPassword } from './password.ts';
import { SessionService, type User } from './sessions.ts';
import { generateToken, hashToken } from './tokens.ts';

/**
 * Fault-injection and issuance-sameness tests for the auth layer.
 *
 * Two guarantees the design leans on, neither of which the happy-path suites
 * (tasks 8.2 / 8.4) exercise:
 *
 *   - Requirement 4.7: a *throw* inside credential resolution — a database
 *     blip, not a rejected credential — becomes a 401, never a 500. A 500 here
 *     would tell a caller their token was probably real.
 *   - Requirement 4.6: the protected handler (and any WorkspaceContext resolver
 *     it fronts) is unreachable without a resolved user. On any auth failure the
 *     code that would read `context.get('user')` never runs; on success the user
 *     is on the context before the handler body.
 *   - Requirement 11.3: passwordless issuance (`issueKnownEmail`) uses the same
 *     issuance mechanism as password sign-in (`issuePassword`) — both funnel
 *     through the private `issueForRow`, producing byte-identical persisted
 *     sessions.
 *
 * Everything here is offline: `requireSession` runs against a stubbed
 * `resolveCredential`, and the `SessionService` issuance tests drive a fake
 * `sql` spy, so a fresh `pnpm test:server` stays green with no database.
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
 * records whether it ran and what user it saw. Using `createApp` means the error
 * envelope and headers are the real ones, so a status/body check is a check of
 * what a client would actually receive.
 */
function harness(resolve: (token: string) => Promise<User>): {
   fetch: (headers: Record<string, string>) => Promise<Response>;
   handlerRan: () => boolean;
   seenUser: () => User | undefined;
} {
   let ran = false;
   let user: User | undefined;

   const route = new Hono<{ Variables: AuthVariables }>();
   route.use('*', requireSession(fakeSessions(resolve)));
   route.get('/', (context) => {
      // Anything a WorkspaceContext resolver would do begins here, by reading
      // the user off the context. If this body runs, auth admitted the caller.
      ran = true;
      user = context.get('user');
      return context.json({ ok: true });
   });

   const registry = new Registry();
   registry.register({ prefix: '/guarded', handler: route });
   const app = createApp(registry);

   return {
      fetch: (headers) => Promise.resolve(app.request('/guarded', { headers: new Headers(headers) })),
      handlerRan: () => ran,
      seenUser: () => user,
   };
}

test('Requirement 4.7: a thrown resolver fault is a 401, never a 500, and the handler never runs', async () => {
   // A generic Error stands in for a database fault inside resolveCredential —
   // distinct from a rejected credential, which throws SessionUnauthenticated.
   // Either way the middleware must answer 401 rather than letting the throw
   // become a 500 that signals the token was probably valid.
   const app = harness(async () => {
      throw new Error('connection reset by peer');
   });
   const response = await app.fetch({ authorization: `Bearer ${GOOD_TOKEN}` });

   assert.equal(response.status, 401);
   assert.notEqual(response.status, 500);
   assert.equal(app.handlerRan(), false);

   const body = JSON.parse(await response.text()) as { error: { code: string } };
   assert.equal(body.error.code, 'UNAUTHENTICATED');
});

test('Requirement 4.6: on an auth failure the protected handler that reads context.get(user) never executes', async () => {
   // Two distinct failure shapes — a resolver throw (fault) and a missing
   // credential (parsing fails before the resolver is even reached) — must both
   // leave the handler, and thus any context.get('user') read, unreached.
   const faulting = harness(async () => {
      throw new Error('database unavailable');
   });
   const faultResponse = await faulting.fetch({ authorization: `Bearer ${GOOD_TOKEN}` });
   assert.equal(faultResponse.status, 401);
   assert.equal(faulting.handlerRan(), false);
   assert.equal(faulting.seenUser(), undefined);

   // No Authorization header at all: the resolver is never invoked, and the
   // handler is still never reached.
   let resolverCalled = false;
   const absent = harness(async () => {
      resolverCalled = true;
      return USER;
   });
   const absentResponse = await absent.fetch({});
   assert.equal(absentResponse.status, 401);
   assert.equal(absent.handlerRan(), false);
   assert.equal(absent.seenUser(), undefined);
   assert.equal(resolverCalled, false);
});

test('Requirement 4.6: on success the resolved user is on the context before the handler body runs', async () => {
   const app = harness(async () => USER);
   const response = await app.fetch({ authorization: `Bearer ${GOOD_TOKEN}` });

   assert.equal(response.status, 200);
   assert.equal(app.handlerRan(), true);
   // The user the handler read off the context is the resolved one, which means
   // requireSession set it before next() handed control on — the only point a
   // downstream context resolver could read it from.
   assert.deepEqual(app.seenUser(), USER);
});

/**
 * A recorded INSERT: the values `issueForRow` persists for one session. Two of
 * these produced by two different public issue methods, holding equal fields,
 * is the behavioural proof both funnel through the one issuance path.
 */
interface RecordedSession {
   userId: string;
   tokenHash: string;
   expiresAt: string;
   createdAt: string;
}

/**
 * A fake `sql` tag that answers the two statements issuance runs: the user
 * SELECT returns the seeded row, and the session INSERT is recorded rather than
 * executed. It is a callable tagged-template that also carries the postgres.js
 * surface the code under test never reaches, cast through `unknown` at the seam.
 */
function fakeSql(row: Record<string, unknown>, inserts: RecordedSession[]): SessionServiceOptionsSql {
   const tag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      if (text.includes('INSERT INTO sessions')) {
         // Positional values, in the order issueForRow interpolates them:
         // id, user_id, token_hash, user_agent, ip, expires_at, created_at.
         inserts.push({
            userId: values[1] as string,
            tokenHash: values[2] as string,
            expiresAt: values[5] as string,
            createdAt: values[6] as string,
         });
         return Promise.resolve(Object.assign([], { count: 1 }));
      }
      // Every SELECT in issuance resolves the same seeded user row.
      return Promise.resolve([row]);
   }) as SessionServiceOptionsSql;
   return tag;
}

/**
 * The one field of `SessionServiceOptions` these tests supply. `SessionService`
 * only ever calls `sql` as a tagged template here, so the fake is a function;
 * the cast narrows the postgres.js type down to what the seam needs.
 */
type SessionServiceOptionsSql = ConstructorParameters<typeof SessionService>[0]['sql'];

test('Requirement 11.3: passwordless issuance uses the same issuance path as password sign-in', async () => {
   // A seeded user carrying a real scrypt credential so issuePassword's
   // verifyPassword succeeds and reaches the shared issuance path — the same
   // path issueKnownEmail reaches directly.
   const password = 'correct horse battery staple';
   const stored = await hashPassword(password);

   const baseRow: Record<string, unknown> = {
      id: USER.id,
      email: USER.email,
      name: USER.name,
      avatar_url: null,
      role: 'member',
      last_workspace_id: null,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
   };
   const rowWithPassword: Record<string, unknown> = {
      ...baseRow,
      password_hash: stored.hash,
      password_salt: stored.salt,
   };

   // Deterministic issuance: a fixed clock, id, and token so the only thing that
   // could differ between the two paths is the path itself. If both funnel
   // through issueForRow, both persist byte-identical values.
   const fixedNow = new Date('2024-06-01T12:00:00.000Z');
   const options = {
      sessionTtlMs: 3_600_000,
      now: () => fixedNow,
      newId: () => '22222222-2222-2222-2222-222222222222',
      randomToken: () => GOOD_TOKEN,
   } as const;

   const passwordlessInserts: RecordedSession[] = [];
   const passwordless = new SessionService({
      ...options,
      sql: fakeSql(baseRow, passwordlessInserts),
   });
   const passwordlessResult = await passwordless.issueKnownEmail(USER.email);

   const passwordInserts: RecordedSession[] = [];
   const passwordBased = new SessionService({
      ...options,
      sql: fakeSql(rowWithPassword, passwordInserts),
   });
   const passwordResult = await passwordBased.issuePassword(USER.email, password);

   // Each path persisted exactly one session.
   assert.equal(passwordlessInserts.length, 1);
   assert.equal(passwordInserts.length, 1);

   const [passwordlessSession] = passwordlessInserts;
   const [passwordSession] = passwordInserts;
   assert.ok(passwordlessSession);
   assert.ok(passwordSession);

   // The persisted session shape is identical, which is only possible if both
   // ran the same issueForRow: same user, same token hash, same expiry from the
   // shared TTL logic, same created_at from the shared clock.
   assert.deepEqual(passwordlessSession, passwordSession);

   // And the persisted values are the shared mechanism's, not coincidence: the
   // token hash is the SHA-256 of the one issued token, and expiry is now + TTL.
   const expectedExpiry = new Date(fixedNow.getTime() + options.sessionTtlMs).toISOString();
   assert.equal(passwordlessSession.tokenHash, hashToken(GOOD_TOKEN));
   assert.equal(passwordlessSession.expiresAt, expectedExpiry);
   assert.equal(passwordlessSession.userId, USER.id);

   // The returned sessions match too — same raw token handed back once, same
   // expiry — confirming the sameness holds end to end, not only at the INSERT.
   assert.equal(passwordlessResult.token, passwordResult.token);
   assert.equal(passwordlessResult.expiresAt, passwordResult.expiresAt);
   assert.equal(passwordlessResult.expiresAt, expectedExpiry);
   assert.deepEqual(passwordlessResult.user, passwordResult.user);
});
