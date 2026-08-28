import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
   InvalidCursor,
   TIME_CURSOR_KEYS,
   decodeCursor,
   encodeCursor,
   parsePageQuery,
} from './cursor.ts';

/**
 * Captured bytes for this key and scope. Clients hold cursors across restarts
 * and deployments, so these are a contract, not an artefact.
 */
const SCOPE = 'identity.workspaces.11111111-1111-4111-8111-111111111101';
const KEY = {
   createdAt: '2026-08-23T05:47:19.652293Z',
   id: '11111111-1111-4111-8111-111111111110',
};
const GO_CURSOR =
   'eyJ2IjoxLCJzY29wZSI6ImlkZW50aXR5LndvcmtzcGFjZXMuMTExMTExMTEtMTExMS00MTExLTgxMTEtMTExMTExMTExMTAxIiwia2V5Ijp7ImNyZWF0ZWRBdCI6IjIwMjYtMDgtMjNUMDU6NDc6MTkuNjUyMjkzWiIsImlkIjoiMTExMTExMTEtMTExMS00MTExLTgxMTEtMTExMTExMTExMTEwIn19';

const TIME_KEY = TIME_CURSOR_KEYS;

test('a cursor encodes to the same bytes Go produces', () => {
   assert.equal(encodeCursor(SCOPE, KEY), GO_CURSOR);
});

test("Go's cursor decodes here, and back again unchanged", () => {
   assert.deepEqual(decodeCursor(GO_CURSOR, SCOPE, TIME_KEY), KEY);
   assert.equal(encodeCursor(SCOPE, decodeCursor(GO_CURSOR, SCOPE, TIME_KEY)), GO_CURSOR);
});

test('a cursor minted for another collection is refused', () => {
   // Scope is what stops a token for one user's workspaces being replayed
   // against another's. It is checked before the key is read.
   assert.throws(
      () => decodeCursor(GO_CURSOR, 'identity.workspaces.some-other-user', TIME_KEY),
      InvalidCursor
   );
});

test('a tampered or malformed token is refused', () => {
   const refused = [
      '',
      '!!!not-base64!!!',
      Buffer.from('{"v":2,"scope":"a","key":{}}').toString('base64url'),
      Buffer.from(`{"v":1,"scope":"${SCOPE}","key":null}`).toString('base64url'),
      Buffer.from(`{"v":1,"scope":"${SCOPE}"}`).toString('base64url'),
      Buffer.from(`{"v":1,"scope":"${SCOPE}","key":{},"extra":1}`).toString('base64url'),
      Buffer.from(`{"v":1,"scope":"${SCOPE}","key":{"createdAt":"","id":"x"}}`).toString('base64url'),
      Buffer.from(`{"v":1,"scope":"${SCOPE}","key":{"createdAt":"x","id":"y","z":1}}`).toString('base64url'),
      'A'.repeat(5000),
   ];
   for (const token of refused) {
      assert.throws(() => decodeCursor(token, SCOPE, TIME_KEY), InvalidCursor, token.slice(0, 40));
   }
});

test('base64 that is not canonical is refused rather than silently trimmed', () => {
   // Buffer.from ignores characters outside the alphabet, so without a
   // round-trip check a token with junk in it would decode to something valid.
   assert.throws(() => decodeCursor(`${GO_CURSOR}***`, SCOPE, TIME_KEY), InvalidCursor);
});

test('an invalid scope cannot be encoded', () => {
   assert.equal(encodeCursor('Has.Capitals', KEY), null);
   assert.equal(encodeCursor('', KEY), null);
});

test('page queries default to 50 and bound at 100', () => {
   const page = (query: string) => parsePageQuery(new URL(`http://x/list${query}`));
   assert.deepEqual(page(''), { first: 50, after: '' });
   assert.deepEqual(page('?first=10'), { first: 10, after: '' });
   assert.deepEqual(page('?first=100'), { first: 100, after: '' });
   assert.equal(page('?after=abc').after, 'abc');
});

test('page queries reject what strconv.Atoi would reject', () => {
   // Number() accepts all of these; Go's Atoi accepts none.
   for (const raw of ['0', '101', '-1', '1e2', ' 5', '0x10', '5.5', 'abc', '']) {
      if (raw === '') continue;
      assert.throws(() => parsePageQuery(new URL(`http://x/list?first=${encodeURIComponent(raw)}`)), raw);
   }
});

test('an unknown or repeated query parameter is refused', () => {
   assert.throws(() => parsePageQuery(new URL('http://x/list?limit=10')));
   assert.throws(() => parsePageQuery(new URL('http://x/list?first=1&first=2')));
   // A mount may allow its own filters alongside the page parameters.
   assert.doesNotThrow(() => parsePageQuery(new URL('http://x/list?role=admin'), ['role']));
});
