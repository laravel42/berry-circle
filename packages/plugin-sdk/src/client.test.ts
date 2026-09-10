import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BerryApiError, BerryClient } from './client.ts';

function recorder(status: number, body: unknown) {
   const calls: { url: string; init: RequestInit }[] = [];
   const fetchImpl = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(status === 204 ? null : JSON.stringify(body), { status });
   };
   return { calls, fetchImpl };
}

test('requests carry the bearer token and hit /v1 paths', async () => {
   const { calls, fetchImpl } = recorder(200, { identifier: 'BER-1' });
   const client = new BerryClient({ apiUrl: 'https://berry.example.com/', token: 'berry_plg_x', fetchImpl });
   await client.getIssue('BER-1');
   await client.updateIssue('BER-1', { title: 'T' });
   await client.storage.put('a/b', { n: 1 });
   assert.equal(calls[0]?.url, 'https://berry.example.com/v1/issues/BER-1');
   assert.equal(new Headers(calls[0]?.init.headers).get('authorization'), 'Bearer berry_plg_x');
   assert.equal(calls[1]?.init.method, 'PATCH');
   assert.equal(calls[1]?.init.body, '{"title":"T"}');
   assert.equal(calls[2]?.url, 'https://berry.example.com/v1/storage/a/b');
   assert.equal(calls[2]?.init.body, '{"value":{"n":1}}');
});

test('a storage miss reads as null; other errors throw with their code', async () => {
   const missing = recorder(404, { error: { code: 'NOT_FOUND', message: 'Storage key not found.' } });
   assert.equal(await new BerryClient({ apiUrl: 'https://b', token: 't', fetchImpl: missing.fetchImpl }).storage.get('k'), null);
   const denied = recorder(403, { error: { code: 'INSUFFICIENT_SCOPE', message: 'no' } });
   await assert.rejects(
      new BerryClient({ apiUrl: 'https://b', token: 't', fetchImpl: denied.fetchImpl }).getIssue('X-1'),
      (error) => error instanceof BerryApiError && error.status === 403 && error.code === 'INSUFFICIENT_SCOPE'
   );
});
