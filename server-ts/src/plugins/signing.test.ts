import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { signPayload } from './signing.ts';

test('the signature is an HMAC of timestamp and body under the signing secret', () => {
   const expected = createHmac('sha256', 'berry_whsec_k').update('1700000000.{"a":1}').digest('hex');
   assert.equal(signPayload('berry_whsec_k', 1700000000, '{"a":1}'), `t=1700000000,v1=${expected}`);
   assert.notEqual(signPayload('berry_whsec_k', 1700000000, '{"a":2}'), signPayload('berry_whsec_k', 1700000000, '{"a":1}'));
});
