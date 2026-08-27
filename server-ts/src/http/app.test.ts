import assert from 'node:assert/strict';
import { test } from 'node:test';
import { json } from './app.ts';
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
