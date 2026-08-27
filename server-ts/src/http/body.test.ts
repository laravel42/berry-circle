import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import { decodeBody, type FieldSpec } from './body.ts';
import { ApiError } from './errors.ts';

/**
 * Go decodes into a struct, so a wrong type or an unknown key fails before a
 * handler runs. These pin the equivalents, because TypeScript has no such step
 * and the difference is observable: a coerced `String(123)` would store "123"
 * where Go answered 422.
 */

const SCHEMA: Record<string, FieldSpec> = {
   name: 'string',
   enabled: 'boolean',
   count: 'number',
   answers: 'stringMap',
   avatar: 'raw',
};

// decodeBody throws inside the handler, so the status has to come off the
// response — a try/catch around app.request never sees it.
async function decode(body: unknown, contentType = 'application/json') {
   const app = new Hono();
   let captured: unknown;
   app.post('/', async (context) => {
      captured = (await decodeBody<Record<string, unknown>>(context, SCHEMA)).value;
      return context.text('ok');
   });
   app.onError((error) =>
      Promise.resolve(new Response('', { status: error instanceof ApiError ? error.status : 500 }))
   );
   const response = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: typeof body === 'string' ? body : JSON.stringify(body),
   });
   return { captured, response };
}

async function statusOf(body: unknown, contentType?: string): Promise<number> {
   return (await decode(body, contentType)).response.status;
}

test('a well-formed body decodes to its declared fields', async () => {
   const { captured } = await decode({ name: 'berry', enabled: true, count: 2 });
   assert.deepEqual(captured, { name: 'berry', enabled: true, count: 2 });
});

test('an unknown field is refused rather than ignored', async () => {
   // Silently dropping `reduceMotion` would leave the caller believing a
   // setting was saved.
   assert.equal(await statusOf({ reduceMotion: true }), 422);
});

test('a wrong type is refused rather than coerced', async () => {
   assert.equal(await statusOf({ name: 123 }), 422);
   assert.equal(await statusOf({ enabled: 'yes' }), 422);
   assert.equal(await statusOf({ count: 'two' }), 422);
   assert.equal(await statusOf({ answers: { role: 5 } }), 422);
});

test('null reads as absent, matching a Go pointer left nil', async () => {
   const { captured } = await decode({ name: null, enabled: true });
   assert.deepEqual(captured, { enabled: true }, 'a null pointer is an omission');
});

test('a raw field keeps its explicit null, because clearing is not omitting', async () => {
   const { captured } = await decode({ avatar: null });
   assert.deepEqual(captured, { avatar: null });
});

test('the content type must be JSON', async () => {
   assert.equal(await statusOf({ name: 'x' }, 'text/plain'), 415);
   assert.equal(await statusOf({ name: 'x' }, 'application/json; charset=utf-8'), 200);
});

test('an empty or malformed body is a 400, not a validation failure', async () => {
   assert.equal(await statusOf(''), 400);
   assert.equal(await statusOf('{'), 400);
   assert.equal(await statusOf('{} trailing'), 400);
});

test('a non-object JSON value is refused', async () => {
   assert.equal(await statusOf('[1,2]'), 422);
   assert.equal(await statusOf('"text"'), 422);
   assert.equal(await statusOf('null'), 422);
});

test('a body over 64KiB is refused by byte count, not character count', async () => {
   // Multi-byte characters make a string longer than its length suggests, so
   // a limit measured in characters would let a larger body through.
   const justUnder = 'é'.repeat(32 * 1024 - 16);
   assert.equal(await statusOf({ name: justUnder }), 200);
   assert.equal(await statusOf({ name: 'é'.repeat(33 * 1024) }), 413);
});
