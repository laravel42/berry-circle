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
   parseBearer,
   parsePersonalToken,
   secretMatches,
} from './tokens.ts';

/**
 * These assertions are the specification: the strict-parse rules are what make
 * every malformed credential indistinguishable, and the sessions already in
 * the database were issued under exactly these rules.
 */

test('parseBearer accepts any single well-formed bearer, not only session-shaped ones', () => {
   assert.equal(parseBearer('Bearer abc.DEF-123_~+/='), 'abc.DEF-123_~+/=');
   const { token } = generatePersonalToken();
   assert.equal(parseBearer(`Bearer ${token}`), token);
});

test('parseBearer refuses every malformed header the same way', () => {
   for (const header of [
      undefined,
      null,
      '',
      'Bearer',
      'Bearer ',
      'bearer abc',
      'Basic abc',
      'Bearer  abc',
      'Bearer abc def',
      'Bearer abc, Bearer def',
      `Bearer ${'a'.repeat(513)}`,
      'Bearer ab"c',
      'Bearer berry_pat_malformed',
   ]) {
      assert.throws(() => parseBearer(header), Unauthenticated, String(header));
   }
});

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

test('every issued token parses, whatever bytes the generator drew', () => {
   // Both halves are base64url, an alphabet that includes '_'. Searching for
   // the separator cut inside the public identifier whenever it contained one,
   // which refused roughly 6 of every 10 tokens — issued, shown to the user
   // once, and never able to authenticate. One draw would pass this most of
   // the time, so draw many.
   for (let i = 0; i < 2000; i += 1) {
      const generated = generatePersonalToken();
      const { publicId, secret } = parsePersonalToken(generated.token);
      assert.equal(publicId, generated.publicId, generated.token);
      assert.ok(secretMatches(secret, generated.secretHash), generated.token);
   }
});

test('a token whose halves are nothing but separators still splits', () => {
   // 0xFF is base64url index 63, which encodes as '_': the worst case the
   // alphabet permits, and deterministic where the loop above is statistical.
   const generated = generatePersonalToken((size) => Buffer.alloc(size, 0xff));
   assert.ok(generated.publicId.includes('_'), generated.publicId);

   const { publicId, secret } = parsePersonalToken(generated.token);
   assert.equal(publicId, generated.publicId);
   assert.ok(secretMatches(secret, generated.secretHash));
});

test('malformed tokens are still refused', () => {
   const remainder = generatePersonalToken().token.slice(PERSONAL_TOKEN_PREFIX.length);
   const refused: Record<string, string> = {
      'no prefix': remainder,
      'wrong prefix': `berry_pat${remainder}`,
      empty: '',
      'prefix only': PERSONAL_TOKEN_PREFIX,
      'short secret': PERSONAL_TOKEN_PREFIX + remainder.slice(0, -1),
      'long secret': `${PERSONAL_TOKEN_PREFIX}${remainder}A`,
      'separator replaced': PERSONAL_TOKEN_PREFIX + remainder.slice(0, 16) + 'A' + remainder.slice(17),
      'invalid alphabet': `${PERSONAL_TOKEN_PREFIX}*${remainder.slice(1)}`,
   };
   for (const [name, token] of Object.entries(refused)) {
      assert.throws(() => parsePersonalToken(token), new RegExp(''), name);
   }
});

test('parsing is a shape check, not authentication', () => {
   // A well-formed token that was never issued parses: separating the halves
   // is all this does. Rejecting it is the store's job, which looks the public
   // identifier up and compares the secret's digest. Pinned so a later reader
   // does not mistake a successful parse for a verified caller.
   const unissued = generatePersonalToken((size) => Buffer.alloc(size, 0x01));
   assert.doesNotThrow(() => parsePersonalToken(unissued.token));
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
