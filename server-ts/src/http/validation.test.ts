import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
   boundedLength,
   validAvatar,
   validEmail,
   validIssuePrefix,
   validTimezone,
   validWorkspaceSlug,
} from './validation.ts';

test('length is counted in runes, as Go counts it', () => {
   // Four emoji are four runes to Go and eight UTF-16 units to JavaScript.
   assert.ok(boundedLength('🍓🍓🍓🍓', 1, 4));
   assert.ok(!boundedLength('🍓🍓🍓🍓', 1, 3));
   assert.ok(!boundedLength('', 1, 10));
});

test('an avatar must be an absolute HTTP(S) URL without credentials', () => {
   assert.ok(validAvatar('https://example.com/a.png'));
   assert.ok(validAvatar('http://example.com/a.png'));
   assert.ok(!validAvatar('not-a-url'));
   assert.ok(!validAvatar('ftp://example.com/a.png'));
   assert.ok(!validAvatar('https://user:pass@example.com/a.png'));
   assert.ok(!validAvatar(`https://example.com/${'a'.repeat(2048)}`));
});

test('a timezone must be one the runtime resolves', () => {
   assert.ok(validTimezone('Europe/Rome'));
   assert.ok(validTimezone('UTC'));
   assert.ok(!validTimezone('Mars/Olympus'));
   assert.ok(!validTimezone(''));
   // Accepted historically, so a stored profile may already carry it.
   assert.ok(validTimezone('Local'));
});

test('workspace slugs and issue prefixes match their Go patterns', () => {
   assert.ok(validWorkspaceSlug('berry-circle'));
   assert.ok(!validWorkspaceSlug('-leading'));
   assert.ok(!validWorkspaceSlug('trailing-'));
   assert.ok(!validWorkspaceSlug('a'));
   assert.ok(!validWorkspaceSlug('Has-Capitals'));

   assert.ok(validIssuePrefix('BER'));
   assert.ok(!validIssuePrefix('B'));
   assert.ok(!validIssuePrefix('lower'));
   assert.ok(!validIssuePrefix('TOOMANYCHARSHERE'));
});

/**
 * Verified against the running Go server, one invitation request per address:
 * 17 addresses, no disagreements. Go's rule is mail.ParseAddress plus
 * `address.Address == value`, which is stricter than parsing alone — it is
 * what rejects the display-name forms.
 */
test('email validity matches Go address for address', () => {
   const accepted = ['a@b.co', 'a@b', 'a+tag@b.co', 'a@b-c.co'];
   const refused = [
      'no-at-sign',
      'a@@b.co',
      'a b@c.co',
      'a@.co',
      'a@b..co',
      '@b.co',
      'a@',
      '"quoted"@b.co',
      'a<b>@c.co',
      'A B <a@b.co>',
      'UPPER@b.co', // callers lowercase before validating; this is not pre-lowered
      'a@b.co ',
      ' a@b.co',
   ];
   for (const value of accepted) assert.ok(validEmail(value), value);
   for (const value of refused) assert.ok(!validEmail(value), value);
});

test('a domain without a dot is accepted, because Go accepts it', () => {
   // Not an oversight: mail.ParseAddress("a@b") succeeds, and the two servers
   // have to agree on what an address is while both are answering.
   assert.ok(validEmail('a@b'));
});
