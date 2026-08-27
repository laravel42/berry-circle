import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
   PERSONAL_TOKEN_PREFIX,
   Unauthenticated,
   generatePersonalToken,
   generateToken,
   hashToken,
   isPersonalToken,
   parseAuthorization,
   parsePersonalToken,
   secretMatches,
} from './tokens.ts';

/**
 * Ported from server/internal/auth/auth_test.go. These assertions are the
 * specification: the strict-parse rules are what make every malformed
 * credential indistinguishable, and the sessions in the database were issued
 * under exactly these rules.
 */

test('a generated token is 256 bits of unpadded base64url', () => {
   const token = generateToken();
   assert.equal(token.length, 43);
   assert.ok(!token.includes('='), 'padding must not appear');
   assert.match(token, /^[A-Za-z0-9_-]+$/);
   assert.equal(Buffer.from(token, 'base64url').length, 32);
});

test('only the hash is ever persisted, and it is stable lowercase hex', () => {
   const token = generateToken();
   const hash = hashToken(token);
   assert.match(hash, /^[0-9a-f]{64}$/);
   assert.equal(hash, hashToken(token), 'hashing must be deterministic');
   assert.notEqual(hash, token);
});

test('a well-formed bearer parses back to the token itself', () => {
   const token = generateToken();
   assert.equal(parseAuthorization(`Bearer ${token}`), token);
});

test('every malformed authorization header is refused the same way', () => {
   const token = generateToken();
   const refused = [
      '',
      'Basic abc',
      'bearer ' + token, // scheme casing
      'Bearer  ' + token, // doubled space
      ' Bearer ' + token, // leading space
      'Bearer ' + token + ' ', // trailing space
      'Bearer ' + token + ' extra', // a second credential
      'Bearer short',
      'Bearer ' + token + '=', // padding
      'Bearer !' + 'a'.repeat(42), // right length, not base64url
      token, // no scheme
   ];
   for (const header of refused) {
      assert.throws(() => parseAuthorization(header), Unauthenticated, `accepted ${header}`);
   }
});

test('base64url is checked strictly, not leniently', () => {
   // Node's decoder ignores characters it does not recognise, so a token with
   // a `+` decodes to the right length and would pass a length-only check.
   const token = generateToken();
   const smuggled = '+' + token.slice(1);
   assert.throws(() => parseAuthorization(`Bearer ${smuggled}`), Unauthenticated);
});

test('a personal token splits into an indexed id and a secret', () => {
   const generated = generatePersonalToken();
   assert.ok(generated.token.startsWith(PERSONAL_TOKEN_PREFIX));
   assert.equal(parseAuthorization(`Bearer ${generated.token}`), generated.token);

   const { publicId, secret } = parsePersonalToken(generated.token);
   assert.equal(publicId, generated.publicId);
   assert.equal(publicId.length, 16);
   assert.equal(secret.length, 43);
   assert.ok(secretMatches(secret, generated.secretHash));
   assert.ok(!secretMatches('wrong', generated.secretHash));
});

test('a malformed personal token never falls through to session parsing', () => {
   const malformed = [
      PERSONAL_TOKEN_PREFIX,
      PERSONAL_TOKEN_PREFIX + 'nosecret',
      PERSONAL_TOKEN_PREFIX + 'short_' + 'a'.repeat(43),
      PERSONAL_TOKEN_PREFIX + 'a'.repeat(16) + '_short',
      PERSONAL_TOKEN_PREFIX + 'a'.repeat(16) + '_' + 'a'.repeat(43) + '_extra',
   ];
   for (const token of malformed) {
      assert.ok(isPersonalToken(token), 'the fixture must claim the namespace');
      assert.throws(() => parsePersonalToken(token), Unauthenticated, `accepted ${token}`);
      assert.throws(() => parseAuthorization(`Bearer ${token}`), Unauthenticated, `accepted ${token}`);
   }
});

test('tokens are unique across generations', () => {
   const seen = new Set(Array.from({ length: 200 }, () => generateToken()));
   assert.equal(seen.size, 200);
});
