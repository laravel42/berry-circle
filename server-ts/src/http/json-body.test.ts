import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import { z } from 'zod';
import { createApp } from './app.ts';
import { readJson } from './json-body.ts';
import { Registry } from './registry.ts';

const schema = z.object({ title: z.string().min(1) }).strict();
const route = new Hono();
route.post('/', async (context) => context.json(await readJson(context, schema)));
const registry = new Registry();
registry.register({ prefix: '/t', handler: route });
const app = createApp(registry);

const post = (body: string, type = 'application/json') =>
   app.request('/t', { method: 'POST', headers: { 'content-type': type }, body });

test('a valid body parses', async () => {
   const response = await post('{"title":"x"}');
   assert.equal(response.status, 200);
   assert.deepEqual(await response.json(), { title: 'x' });
});

test('wrong media type, bad JSON and schema failures get their own statuses', async () => {
   assert.equal((await post('{}', 'text/plain')).status, 415);
   assert.equal((await post('{nope')).status, 400);
   const invalid = await post('{"title":""}');
   assert.equal(invalid.status, 422);
   const body = (await invalid.json()) as { error: { details: { fields: { path: string }[] } } };
   assert.equal(body.error.details.fields[0]?.path, '/title');
});
