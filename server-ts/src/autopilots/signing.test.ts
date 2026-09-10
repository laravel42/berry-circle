import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
   hashToken,
   newSigningSecret,
   newWebhookToken,
   signBody,
   tokenHint,
   validTokenShape,
   verifySignature,
} from './signing.ts';

test('a body signed with the secret verifies, and a tampered one does not', () => {
   const secret = newSigningSecret();
   const body = JSON.stringify({ event: 'deploy' });
   const signature = signBody(body, secret);
   assert.match(signature, /^sha256=[0-9a-f]{64}$/);
   assert.equal(verifySignature(body, signature, secret), true);
   assert.equal(verifySignature(body + ' ', signature, secret), false);
   assert.equal(verifySignature(body, signature, newSigningSecret()), false);
});

test('tokens are unguessable, well-shaped and distinct', () => {
   const first = newWebhookToken();
   const second = newWebhookToken();
   assert.notEqual(first, second);
   assert.equal(validTokenShape(first), true);
   assert.equal(validTokenShape('apw_short'), false);
   assert.equal(validTokenShape('../../etc/passwd'), false);
});

test('a token is looked up by a fixed-length hash, and only its tail is shown', () => {
   const token = newWebhookToken();
   assert.equal(hashToken(token).length, 32);
   assert.deepEqual(hashToken(token), hashToken(token));
   assert.equal(tokenHint(token), token.slice(-4));
});

test('a signing secret is long enough to be a key', () => {
   assert.match(newSigningSecret(), /^whsec_[A-Za-z0-9_-]{43}$/);
});
