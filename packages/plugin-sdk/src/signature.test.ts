import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { verifySignature } from './signature.ts';

const sign = (secret: string, t: number, body: string) =>
   `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;

test('a fresh signature over the exact body verifies', () => {
   const now = 1_700_000_000;
   assert.equal(verifySignature({ secret: 's', header: sign('s', now, '{}'), body: '{}', now }), true);
});

test('a wrong secret, altered body, stale timestamp or missing header fails', () => {
   const now = 1_700_000_000;
   assert.equal(verifySignature({ secret: 'x', header: sign('s', now, '{}'), body: '{}', now }), false);
   assert.equal(verifySignature({ secret: 's', header: sign('s', now, '{}'), body: '{ }', now }), false);
   assert.equal(verifySignature({ secret: 's', header: sign('s', now - 600, '{}'), body: '{}', now }), false);
   assert.equal(verifySignature({ secret: 's', header: null, body: '{}', now }), false);
   assert.equal(verifySignature({ secret: 's', header: 'garbage', body: '{}', now }), false);
});
