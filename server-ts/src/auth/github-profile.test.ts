import assert from 'node:assert/strict';
import { test } from 'node:test';

import { githubProfileToUser } from './better-auth.ts';

test('a real email is kept, because it is what links an existing user', () => {
   assert.deepEqual(githubProfileToUser({ login: 'octo', name: 'Octo Cat', email: 'octo@berry.test' }), {
      email: 'octo@berry.test',
      name: 'Octo Cat',
   });
});

test('a private email falls back to the address GitHub hands out for it', () => {
   assert.deepEqual(githubProfileToUser({ login: 'octo', name: 'Octo Cat', email: null }), {
      email: 'octo@users.noreply.github.com',
      name: 'Octo Cat',
      emailVerified: true,
   });
});

test('a real address keeps GitHub\'s own verdict rather than claiming it is verified', () => {
   assert.equal(
      'emailVerified' in githubProfileToUser({ login: 'octo', email: 'octo@berry.test' }),
      false
   );
});

test('a profile with no name is known by its login', () => {
   assert.equal(githubProfileToUser({ login: 'octo', email: '' }).name, 'octo');
});

test('blank is not an email: nothing is invented without a login', () => {
   assert.equal(githubProfileToUser({ login: '  ', email: '  ' }).email, '');
});
