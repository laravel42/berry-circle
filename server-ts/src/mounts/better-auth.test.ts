import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createApp } from '../http/app.ts';
import { Registry } from '../http/registry.ts';
import { betterAuthMounts } from './better-auth.ts';

function appWith(handler: (request: Request) => Promise<Response>) {
   const registry = new Registry();
   registry.registerAll(betterAuthMounts({ handler }));
   return createApp(registry);
}

test('everything under /api/auth reaches Better Auth with the original URL', async () => {
   const seen: string[] = [];
   const app = appWith(async (request) => {
      seen.push(`${request.method} ${new URL(request.url).pathname}`);
      return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
   });
   assert.equal((await app.request('/api/auth/ok')).status, 200);
   await app.request('/api/auth/sign-in/social', { method: 'POST', body: '{}' });
   assert.deepEqual(seen, ['GET /api/auth/ok', 'POST /api/auth/sign-in/social']);
});

test('a redirect from Better Auth survives the standard headers', async () => {
   // Response.redirect() has immutable headers; the shell must still stamp its
   // own security headers on it rather than throwing a 500.
   const app = appWith(async () => Response.redirect('http://localhost:3000/', 302));
   const response = await app.request('/api/auth/callback/github?code=x&state=y');
   assert.equal(response.status, 302);
   assert.equal(response.headers.get('location'), 'http://localhost:3000/');
   assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});

test('the Better Auth prefix does not shadow /api/v1', () => {
   const registry = new Registry();
   registry.registerAll(betterAuthMounts({ handler: async () => new Response(null) }));
   registry.register({ prefix: '/api/v1/auth', handler: new (class {})() as never });
   assert.deepEqual(registry.prefixes.sort(), ['/api/auth', '/api/v1/auth']);
});
