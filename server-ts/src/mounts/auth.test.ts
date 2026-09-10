import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Sql } from '../db/pool.ts';
import { SessionService } from '../auth/sessions.ts';
import { createApp } from '../http/app.ts';
import { Registry } from '../http/registry.ts';
import { authMounts } from './auth.ts';

const ROW = {
   id: '11111111-1111-1111-1111-111111111111',
   email: 'ada@berry.test',
   name: 'Ada',
   avatar_url: null,
   role: 'member',
   last_workspace_id: null,
   created_at: '2026-01-01T00:00:00Z',
   updated_at: '2026-01-01T00:00:00Z',
};

function build(
   devSession: ((userId: string) => Promise<string[]>) | null,
   rows: unknown[] = [ROW]
) {
   const sql = (async () => rows) as unknown as Sql;
   const sessions = new SessionService({
      sql,
      auth: {
         getSession: async ({ headers }) =>
            headers.get('cookie')?.includes('berry.session_token=good')
               ? { user: { id: ROW.id } }
               : null,
      },
   });
   const registry = new Registry();
   registry.registerAll(authMounts({ sessions, sql, devSession }));
   return createApp(registry);
}

test('GET /api/v1/auth/me answers for a session cookie', async () => {
   const response = await build(null).request('/api/v1/auth/me', {
      headers: { cookie: 'berry.session_token=good' },
   });
   assert.equal(response.status, 200);
   const body = (await response.json()) as Record<string, unknown>;
   assert.deepEqual(Object.keys(body), [
      'id',
      'email',
      'name',
      'avatarUrl',
      'role',
      'createdAt',
      'updatedAt',
   ]);
});

test('the password and passwordless routes are gone', async () => {
   const app = build(null);
   for (const path of ['login', 'sign-in', 'sign-up', 'sign-out', 'logout']) {
      const response = await app.request(`/api/v1/auth/${path}`, { method: 'POST', body: '{}' });
      assert.equal(response.status, 404, path);
   }
});

test('dev login is not served unless the deployment enabled it', async () => {
   const response = await build(null).request('/api/v1/auth/dev-login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'ada@berry.test' }),
   });
   assert.equal(response.status, 404);
});

test('dev login sets the session cookie for a known email', async () => {
   const minted: string[] = [];
   const app = build(async (userId) => {
      minted.push(userId);
      return ['berry.session_token=abc.sig; Path=/; HttpOnly; SameSite=Lax'];
   });
   const response = await app.request('/api/v1/auth/dev-login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'ADA@berry.test' }),
   });
   assert.equal(response.status, 200);
   assert.deepEqual(minted, [ROW.id]);
   assert.match(response.headers.getSetCookie().join('\n'), /berry\.session_token=abc\.sig/);
});

test('dev login for an unknown email is the uniform 401', async () => {
   const app = build(async () => ['x=y'], []);
   const response = await app.request('/api/v1/auth/dev-login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@berry.test' }),
   });
   assert.equal(response.status, 401);
});
