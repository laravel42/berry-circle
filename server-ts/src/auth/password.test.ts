// Feature: auth-and-tenant-isolation, Property 10: Passwords are stored as
// distinct salted one-way hashes.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import fc from 'fast-check';

import { hashPassword, verifyPassword } from './password.ts';

// scrypt with N=32768 is deliberately slow, and each iteration below performs
// several derivations, so keep the run bounded while still meeting the ≥100
// iteration floor the property suite requires.
const RUNS = 100;

// Passwords are 12..128 characters and may contain any unicode, matching the
// input space the property describes (Requirements 1.5, 2.1).
const password = fc.string({ minLength: 12, maxLength: 128, unit: 'grapheme' });

// A second, distinct password used to check that verification rejects anything
// other than the original. Constrained to differ from the first.
const twoDistinctPasswords = fc
   .tuple(password, password)
   .filter(([a, b]) => a !== b);

test(
   'Feature: auth-and-tenant-isolation, Property 10: Passwords are stored as distinct salted one-way hashes',
   async () => {
      await fc.assert(
         fc.asyncProperty(password, async (pw) => {
            const stored = await hashPassword(pw);

            // The stored hash is not the plaintext bytes: a one-way transform,
            // not storage of the secret itself.
            assert.notDeepEqual(
               Buffer.from(stored.hash),
               Buffer.from(pw, 'utf8'),
               'stored hash must differ from the plaintext bytes'
            );

            // Two independent hashings of the same password draw fresh salts and
            // therefore produce different salts and different hashes.
            const again = await hashPassword(pw);
            assert.ok(
               !stored.salt.equals(again.salt),
               'two independent hashings must use different salts'
            );
            assert.ok(
               !stored.hash.equals(again.hash),
               'two independent hashings must produce different hashes'
            );

            // verifyPassword accepts the original password against its own pair.
            assert.equal(
               await verifyPassword(pw, stored),
               true,
               'verifyPassword must accept the original password'
            );
         }),
         { numRuns: RUNS }
      );
   }
);

test(
   'Feature: auth-and-tenant-isolation, Property 10: verifyPassword rejects any other password',
   async () => {
      await fc.assert(
         fc.asyncProperty(twoDistinctPasswords, async ([pw, other]) => {
            const stored = await hashPassword(pw);
            assert.equal(
               await verifyPassword(other, stored),
               false,
               'verifyPassword must reject a password other than the original'
            );
         }),
         { numRuns: RUNS }
      );
   }
);
