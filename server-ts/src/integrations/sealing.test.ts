import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
   SealingFailed,
   SealingUnavailable,
   sealerFromKey,
   secretsEqual,
   unavailableSealer,
} from './sealing.ts';

/**
 * Credential sealing.
 *
 * The vector below is the load-bearing test. Rows sealed by the implementation
 * that came before this one are in the database, and a layout change here
 * would not fail — it would quietly stop opening them, and GitHub would look
 * as if it had disconnected itself.
 */

/** All-zero-through-31 key, so the vector is reproducible by anyone. */
const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';

/**
 * Produced by an independent AES-256-GCM implementation (Python's
 * `cryptography`) with that key, nonce `000102…0b`, and the plaintext below,
 * laid out as `nonce ‖ ciphertext ‖ tag`.
 *
 * AES-GCM is deterministic for a given key, nonce and plaintext, so these are
 * the bytes every correct implementation produces. If this test fails, the
 * algorithm or the layout changed and stored credentials no longer open.
 */
const SEALED =
   'AAECAwQFBgcICQoLIGqjRICdo3b9LfLf3oIdA82582aVGjNMCFfVtS1ZMIIxIJ7Mn/EiqESNBlo/Xm7KvHL72PGAOROG';
const PLAINTEXT = 'ghu_ExampleTokenNotReal000000000000000000';

test('a value sealed by another implementation opens here', () => {
   const sealer = sealerFromKey(KEY);
   assert.equal(sealer.open(Buffer.from(SEALED, 'base64')), PLAINTEXT);
});

test('the layout is nonce, ciphertext, tag — the one already in the database', () => {
   const sealed = sealerFromKey(KEY).seal(PLAINTEXT);
   // 12-byte nonce and 16-byte tag around a ciphertext the length of the
   // plaintext. A row of 68 bytes holds a 40-character token.
   assert.equal(sealed.length, 12 + PLAINTEXT.length + 16);
});

test('sealing round-trips, and never twice the same way', () => {
   const sealer = sealerFromKey(KEY);
   const first = sealer.seal(PLAINTEXT);
   const second = sealer.seal(PLAINTEXT);
   assert.equal(sealer.open(first), PLAINTEXT);
   assert.equal(sealer.open(second), PLAINTEXT);
   // A fresh nonce each time: identical ciphertexts would tell an observer
   // with database access which workspaces share a credential.
   assert.notEqual(first.toString('base64'), second.toString('base64'));
});

test('a tampered value is refused rather than decrypted to rubbish', () => {
   // Without authentication this would return bytes that Berry then sends to
   // GitHub as a token.
   const sealer = sealerFromKey(KEY);
   const sealed = sealerFromKey(KEY).seal(PLAINTEXT);

   for (const index of [0, 20, sealed.length - 1]) {
      const tampered = Buffer.from(sealed);
      tampered[index] = (tampered[index] ?? 0) ^ 0xff;
      assert.throws(() => sealer.open(tampered), SealingFailed, `byte ${index} was not detected`);
   }
});

test('the wrong key is refused, and says nothing about the value', () => {
   const other = sealerFromKey(Buffer.alloc(32, 7).toString('base64'));
   assert.throws(
      () => other.open(Buffer.from(SEALED, 'base64')),
      (error: Error) => {
         assert.equal(error.name, 'SealingFailed');
         // No oracle: "wrong key" and "tampered" read the same.
         assert.doesNotMatch(error.message, /key|tamper/i);
         return true;
      }
   );
});

test('a value too short to be sealed is refused before the cipher sees it', () => {
   assert.throws(() => sealerFromKey(KEY).open(Buffer.alloc(20)), SealingFailed);
});

test('a key that is missing or the wrong size refuses at construction', () => {
   // Never at the point of use, and never by generating one: a key that
   // appeared on its own would differ between restarts and strand every
   // credential already stored.
   assert.throws(() => sealerFromKey(''), SealingUnavailable);
   assert.throws(() => sealerFromKey('   '), SealingUnavailable);
   assert.throws(
      () => sealerFromKey(Buffer.alloc(16).toString('base64')),
      (error: Error) => {
         assert.equal(error.name, 'SealingUnavailable');
         assert.match(error.message, /32 bytes, got 16/);
         return true;
      }
   );
});

test('an unconfigured deployment refuses both directions', () => {
   // Refusing to seal matters as much as refusing to open: the alternative is
   // storing a credential in the clear because the key was missing.
   const sealer = unavailableSealer('no key configured');
   assert.throws(() => sealer.seal('secret'), SealingUnavailable);
   assert.throws(() => sealer.open(Buffer.alloc(40)), SealingUnavailable);
});

test('secret comparison does not depend on where two values differ', () => {
   assert.equal(secretsEqual('ghu_abc', 'ghu_abc'), true);
   assert.equal(secretsEqual('ghu_abc', 'ghu_abd'), false);
   assert.equal(secretsEqual('ghu_abc', 'ghu_abcd'), false);
   assert.equal(secretsEqual('', ''), true);
});
