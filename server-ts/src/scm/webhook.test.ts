import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { verifySignature } from './webhook.ts';

/**
 * The three protections on the inbound route.
 *
 * Signature verification is the authentication for a caller that has no
 * session, so these are the tests that stand between a stranger and every task
 * in the deployment.
 */

const SECRET = 'a-shared-secret';
const BODY = JSON.stringify({ action: 'closed', issue: { id: 4 } });

function sign(body: string, secret = SECRET): string {
   return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

test('a correctly signed body is accepted', () => {
   assert.equal(verifySignature(BODY, sign(BODY), SECRET), true);
});

test('a body signed with another secret is refused', () => {
   assert.equal(verifySignature(BODY, sign(BODY, 'not-the-secret'), SECRET), false);
});

test('a tampered body is refused', () => {
   // The whole point: the signature covers the bytes, so changing which issue
   // is closed invalidates it.
   const signature = sign(BODY);
   const tampered = JSON.stringify({ action: 'closed', issue: { id: 99 } });
   assert.equal(verifySignature(tampered, signature, SECRET), false);
});

test('an absent signature is refused', () => {
   assert.equal(verifySignature(BODY, '', SECRET), false);
});

test('a deployment with no secret verifies nothing', () => {
   // The route refuses outright rather than accepting everything; this is the
   // second line of that decision.
   assert.equal(verifySignature(BODY, sign(BODY), ''), false);
});

test('a signature of the wrong length is refused rather than throwing', () => {
   // timingSafeEqual throws on a length mismatch; the length is checked first
   // so a short signature is an answer, not a crash.
   assert.equal(verifySignature(BODY, 'abcd', SECRET), false);
});

test('a signature that is not hex is refused', () => {
   assert.equal(verifySignature(BODY, 'zzzz'.repeat(16), SECRET), false);
});

test('GitHub’s sha256= prefix is accepted, and so is a bare digest', () => {
   // GitHub sends `X-Hub-Signature-256: sha256=<hex>`. The signature is what
   // is being checked, not its packaging.
   const digest = sign(BODY);
   assert.equal(verifySignature(BODY, `sha256=${digest}`, SECRET), true);
   assert.equal(verifySignature(BODY, digest, SECRET), true);
});

test('a prefixed signature for another body is still refused', () => {
   const other = JSON.stringify({ action: 'opened' });
   assert.equal(verifySignature(BODY, `sha256=${sign(other)}`, SECRET), false);
});
