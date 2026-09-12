import assert from 'node:assert/strict';
import { test } from 'node:test';

import { NO_APP_SLUG_REASON, installSlug } from './integrations.ts';

/**
 * Which App an install is offered on.
 *
 * Berry has two shapes of GitHub App: one it created for itself, whose slug came
 * back from GitHub with everything else, and one whose sign-in credentials an
 * operator handed it — where the slug is configuration, because it is the only
 * part of somebody else's App that is not a secret. The stored one wins; the
 * configured one is what makes the second shape able to offer an install at all.
 *
 * Pure on purpose. `github_apps` is a deployment singleton, so a test that
 * asserted the *absence* of a row would be answering for whatever other test
 * file happened to be writing one at the same moment.
 */

test("a stored App's slug is the one an install is offered on", () => {
   assert.equal(installSlug({ slug: 'berry-created' }, 'berry-configured'), 'berry-created');
});

test('the configured slug stands in when no App is stored', () => {
   assert.equal(installSlug(null, 'berry-configured'), 'berry-configured');
});

test('an empty configured slug is no slug at all', () => {
   assert.equal(installSlug(null, ''), null);
   assert.equal(installSlug(null, '   '), null);
   assert.equal(installSlug(null, undefined), null);
   assert.equal(installSlug(null, null), null);
});

test('a stored App with a blank slug falls back rather than offering nothing', () => {
   assert.equal(installSlug({ slug: '   ' }, 'berry-configured'), 'berry-configured');
});

test('the reason given when there is no App names the setting an operator sets', () => {
   assert.match(NO_APP_SLUG_REASON, /BERRY_GITHUB_APP_SLUG/);
});
