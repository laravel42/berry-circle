import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyStandardHeaders, createApp, json } from './app.ts';
import { overlaps, Registry, MountConflict } from './registry.ts';
import { Hono } from 'hono';

test('every JSON body ends with the newline Go writes', async () => {
   // json.NewEncoder(w).Encode appends one, so every Berry response ends 0x0a.
   // One byte, and the difference between identical and nearly.
   const body = await json({ status: 'ok' }).text();
   assert.equal(body, '{"status":"ok"}\n');
});

test('key order is construction order, because bodies are compared whole', async () => {
   const body = await json({ checks: { database: true }, status: 'ready' }).text();
   assert.equal(body, '{"checks":{"database":true},"status":"ready"}\n');
});

test('prefixes that could match the same path are refused', () => {
   assert.ok(overlaps('/api/v1/issues', '/api/v1/issues'));
   assert.ok(overlaps('/api/v1/issues', '/api/v1/issues/comments'));
   assert.ok(overlaps('/', '/anything'));
   assert.ok(!overlaps('/api/v1/issues', '/api/v1/issue-query'));
   assert.ok(!overlaps('/health', '/ready'));
});

test('a conflicting mount fails at startup, not at request time', () => {
   const registry = new Registry();
   registry.register({ prefix: '/api/v1/issues', handler: new Hono() });
   assert.throws(
      () => registry.register({ prefix: '/api/v1/issues/comments', handler: new Hono() }),
      MountConflict
   );
});

test('a prefix must be absolute and must not trail a slash', () => {
   const registry = new Registry();
   assert.throws(() => registry.register({ prefix: 'api/v1/x', handler: new Hono() }));
   assert.throws(() => registry.register({ prefix: '/api/v1/x/', handler: new Hono() }));
});

test('every response carries the headers Go sets', async () => {
   // Captured from `curl -D- http://127.0.0.1:4000/health`. This server
   // shipped with none of them: they were set through context.header, which a
   // handler returning its own Response never sees.
   const headers = new Headers();
   applyStandardHeaders(headers, 'req_abc');
   assert.equal(headers.get('X-Content-Type-Options'), 'nosniff');
   assert.equal(headers.get('X-Frame-Options'), 'DENY');
   assert.equal(headers.get('Referrer-Policy'), 'no-referrer');
   assert.equal(
      headers.get('Content-Security-Policy'),
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
   );
   assert.equal(headers.get('Permissions-Policy'), 'camera=(), microphone=(), geolocation=()');
   assert.equal(headers.get('X-Request-Id'), 'req_abc');
});

test('the headers survive a handler that returns its own Response', async () => {
   // The regression itself: json() builds a fresh Response, so anything set on
   // the Hono context beforehand is discarded.
   const registry = new Registry();
   const route = new Hono();
   route.get('/', () => json({ ok: true }));
   registry.register({ prefix: '/probe', handler: route });

   const response = await createApp(registry).request('/probe');
   assert.equal(response.headers.get('X-Frame-Options'), 'DENY');
   assert.match(response.headers.get('X-Request-Id') ?? '', /^req_[0-9a-f]{32}$/);
});

test('a client-supplied request id is echoed only when it is safe', async () => {
   const registry = new Registry();
   const route = new Hono();
   route.get('/', () => json({ ok: true }));
   registry.register({ prefix: '/probe', handler: route });
   const app = createApp(registry);

   const good = await app.request('/probe', { headers: { 'x-request-id': 'req_' + 'a'.repeat(32) } });
   assert.equal(good.headers.get('X-Request-Id'), 'req_' + 'a'.repeat(32));

   // An arbitrary header value reaches the logs and the error envelope.
   const bad = await app.request('/probe', { headers: { 'x-request-id': 'has space' } });
   assert.notEqual(bad.headers.get('X-Request-Id'), 'has space');
});
