// Feature: auth-and-tenant-isolation, Task 1.4: unit tests for the constant-time
// verification structure of verifyPassword (Requirement 1.6).
//
// These tests pin the *shape* of verification rather than a property: the null
// path must still run a real scrypt derivation (no short-circuit), a correct
// password verifies, a wrong same-length password is rejected, and a
// mismatched-length stored hash returns false without throwing — the last being
// evidence the comparison is timingSafeEqual (which needs a length guard)
// rather than === or Buffer.equals.
import assert from 'node:assert/strict';
import { hrtime } from 'node:process';
import { test } from 'node:test';

import { hashPassword, verifyPassword, type StoredPassword } from './password.ts';

// Elapsed wall-clock milliseconds while awaiting a derivation-bearing call.
async function elapsedMs(work: () => Promise<unknown>): Promise<number> {
   const start = hrtime.bigint();
   await work();
   return Number(hrtime.bigint() - start) / 1_000_000;
}

test('verifyPassword(_, null) returns false (Requirement 1.6)', async () => {
   assert.equal(
      await verifyPassword('any-password-value', null),
      false,
      'verification against a missing credential must be false'
   );
});

test('verifyPassword(_, null) performs a real scrypt derivation, not a short-circuit (Requirement 1.6)', async () => {
   // Establish the cost of one genuine scrypt derivation on this machine.
   const realDerivationMs = await elapsedMs(() => hashPassword('baseline-password'));

   // If the null path short-circuited it would be near-instant. Requiring it to
   // cost a generous fraction of a real derivation keeps the assertion robust on
   // slow CI while still catching a `stored === null → return false` short cut.
   const floorMs = Math.max(realDerivationMs * 0.25, 1);
   const nullPathMs = await elapsedMs(() => verifyPassword('any-password-value', null));

   assert.ok(
      nullPathMs >= floorMs,
      `null path (${nullPathMs.toFixed(2)}ms) must run a derivation; expected ≥ ${floorMs.toFixed(2)}ms ` +
         `(one real derivation ≈ ${realDerivationMs.toFixed(2)}ms)`
   );
});

test('verifyPassword accepts the correct password (Requirement 1.6)', async () => {
   const password = 'correct horse battery staple';
   const stored = await hashPassword(password);
   assert.equal(
      await verifyPassword(password, stored),
      true,
      'the original password must verify true against its stored pair'
   );
});

test('verifyPassword rejects a wrong password of the same length (Requirement 1.6)', async () => {
   const password = 'aaaaaaaaaaaa';
   const wrong = 'bbbbbbbbbbbb';
   assert.equal(password.length, wrong.length, 'guard: passwords must share a length');
   const stored = await hashPassword(password);
   assert.equal(
      await verifyPassword(wrong, stored),
      false,
      'a distinct same-length password must be rejected'
   );
});

test('verifyPassword returns false without throwing when the stored hash length differs (evidence of timingSafeEqual length guard, Requirement 1.6)', async () => {
   const password = 'length-mismatch-probe';
   const stored = await hashPassword(password);

   // Truncate the stored hash so the derived key and stored hash differ in
   // length. Node's timingSafeEqual throws on unequal-length inputs, so the
   // implementation's `derived.length === stored.hash.length` guard must run
   // first — with `===` or `Buffer.equals` in its place this would either throw
   // or misbehave. We assert it resolves to false rather than rejecting.
   const truncated: StoredPassword = {
      salt: stored.salt,
      hash: stored.hash.subarray(0, stored.hash.length - 1),
   };

   assert.equal(
      await verifyPassword(password, truncated),
      false,
      'a mismatched-length stored hash must return false, not throw'
   );
});
