import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Sql } from '../db/pool.ts';
import type { BearerResolver } from './credentials.ts';
import { generatePersonalToken } from './tokens.ts';
import {
   CrossOriginRefused,
   SessionService,
   SessionUnauthenticated,
   type SessionLookup,
   type User,
} from './sessions.ts';

const USER_ROW = {
   id: '11111111-1111-1111-1111-111111111111',
   email: 'ada@berry.test',
   name: 'Ada',
   avatar_url: null,
   role: 'member',
   last_workspace_id: null,
   created_at: '2026-01-01T00:00:00Z',
   updated_at: '2026-01-01T00:00:00Z',
};

const PAT_USER: User = {
   id: '22222222-2222-2222-2222-222222222222',
   email: 'pat@berry.test',
   name: 'Pat',
   avatarUrl: null,
   role: 'member',
   currentWorkspaceId: null,
   createdAt: '2026-01-01T00:00:00Z',
   updatedAt: '2026-01-01T00:00:00Z',
};

function sqlReturning(rows: unknown[]): Sql {
   return (async () => rows) as unknown as Sql;
}

/** A Better Auth stand-in: a session exists exactly when the cookie says so. */
function cookieAuth(calls: { count: number } = { count: 0 }): SessionLookup {
   return {
      async getSession({ headers }) {
         calls.count += 1;
         return headers.get('cookie')?.includes('berry.session_token=good')
            ? { user: { id: USER_ROW.id } }
            : null;
      },
   };
}

// Well-formed PATs: parseBearer refuses a malformed token in the berry_pat_
// namespace before any resolver sees it, so the fixtures must be real shapes.
const GOOD_PAT = generatePersonalToken().token;
const BAD_PAT = generatePersonalToken().token;

const patResolver: BearerResolver = {
   name: 'personal-token',
   matches: (token) => token.startsWith('berry_pat_'),
   async resolve(token) {
      if (token === GOOD_PAT) return PAT_USER;
      throw new Error('refused');
   },
};

function service(overrides: Partial<ConstructorParameters<typeof SessionService>[0]> = {}) {
   return new SessionService({
      sql: sqlReturning([USER_ROW]),
      auth: cookieAuth(),
      bearer: [patResolver],
      trustedOrigins: ['http://localhost:3000'],
      ...overrides,
   });
}

function request(init: { method?: string; headers?: Record<string, string> } = {}): Request {
   return new Request('http://localhost:4000/api/v1/me', {
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
   });
}

test('a valid session cookie resolves to the users row', async () => {
   const user = await service().resolveRequest(
      request({ headers: { cookie: 'berry.session_token=good' } })
   );
   assert.equal(user.id, USER_ROW.id);
   assert.equal(user.role, 'member');
});

test('no credential at all is unauthenticated', async () => {
   await assert.rejects(service().resolveRequest(request()), SessionUnauthenticated);
});

test('a server with no Better Auth instance refuses every cookie', async () => {
   await assert.rejects(
      service({ auth: null }).resolveRequest(
         request({ headers: { cookie: 'berry.session_token=good' } })
      ),
      SessionUnauthenticated
   );
});

test('a bearer is decided by its resolver and never falls back to the cookie', async () => {
   const calls = { count: 0 };
   const sessions = service({ auth: cookieAuth(calls) });
   const user = await sessions.resolveRequest(
      request({
         headers: { authorization: `Bearer ${GOOD_PAT}`, cookie: 'berry.session_token=good' },
      })
   );
   assert.equal(user.id, PAT_USER.id);
   await assert.rejects(
      sessions.resolveRequest(
         request({
            headers: { authorization: `Bearer ${BAD_PAT}`, cookie: 'berry.session_token=good' },
         })
      )
   );
   assert.equal(calls.count, 0, 'the cookie was never consulted');
});

test('a bearer no resolver claims is refused, including an old session token', async () => {
   await assert.rejects(
      service().resolveRequest(
         request({ headers: { authorization: 'Bearer oldOpaqueSessionToken' } })
      ),
      SessionUnauthenticated
   );
});

test('a malformed or stacked Authorization header is refused', async () => {
   for (const authorization of [
      'bearer berry_pat_ok',
      'Bearer  berry_pat_ok',
      'Bearer berry_pat_ok, Bearer x',
   ]) {
      await assert.rejects(
         service().resolveRequest(request({ headers: { authorization } })),
         SessionUnauthenticated,
         authorization
      );
   }
});

test('a cookie-authenticated write from a foreign origin is refused', async () => {
   await assert.rejects(
      service().resolveRequest(
         request({
            method: 'POST',
            headers: { cookie: 'berry.session_token=good', origin: 'https://evil.test' },
         })
      ),
      CrossOriginRefused
   );
});

test('a cookie-authenticated write from a trusted origin, and a foreign-origin read, are allowed', async () => {
   const sessions = service();
   await sessions.resolveRequest(
      request({
         method: 'PATCH',
         headers: { cookie: 'berry.session_token=good', origin: 'http://localhost:3000' },
      })
   );
   await sessions.resolveRequest(
      request({
         method: 'GET',
         headers: { cookie: 'berry.session_token=good', origin: 'https://evil.test' },
      })
   );
});

test('a session whose user row is gone is unauthenticated', async () => {
   await assert.rejects(
      service({ sql: sqlReturning([]) }).resolveRequest(
         request({ headers: { cookie: 'berry.session_token=good' } })
      ),
      SessionUnauthenticated
   );
});
