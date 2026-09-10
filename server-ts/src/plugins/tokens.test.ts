import assert from 'node:assert/strict';
import { test } from 'node:test';
import { digestToken, Unauthenticated } from '../auth/tokens.ts';
import {
   generatePluginToken,
   generateSigningSecret,
   isPluginToken,
   parsePluginToken,
   PLUGIN_TOKEN_PREFIX,
} from './tokens.ts';

test('a generated plugin token parses back to its halves', () => {
   const generated = generatePluginToken();
   assert.ok(generated.token.startsWith(PLUGIN_TOKEN_PREFIX));
   assert.ok(isPluginToken(generated.token));
   const parsed = parsePluginToken(generated.token);
   assert.equal(parsed.publicId, generated.publicId);
   assert.deepEqual(digestToken(parsed.secret), generated.secretHash);
});

test('a public id containing the separator still splits by position', () => {
   // 0xff bytes encode to '_' in base64url, so the id is full of separators.
   const token = generatePluginToken((size) => Buffer.alloc(size, 0xff)).token;
   const parsed = parsePluginToken(token);
   assert.equal(parsed.publicId.length, 16);
   assert.equal(parsed.secret.length, 43);
});

test('malformed plugin tokens are refused identically', () => {
   const good = generatePluginToken().token;
   for (const bad of [
      'berry_pat_' + good.slice(PLUGIN_TOKEN_PREFIX.length),
      good.slice(0, -1),
      good + 'A',
      good.slice(0, -1) + '+',
      PLUGIN_TOKEN_PREFIX,
   ]) {
      assert.throws(() => parsePluginToken(bad), Unauthenticated);
   }
});

test('signing secrets are prefixed and unique', () => {
   const a = generateSigningSecret();
   const b = generateSigningSecret();
   assert.match(a, /^berry_whsec_[A-Za-z0-9_-]{43}$/);
   assert.notEqual(a, b);
});
