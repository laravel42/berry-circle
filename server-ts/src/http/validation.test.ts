import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boundedLength, validAvatar, validIssuePrefix, validTimezone, validWorkspaceSlug } from './validation.ts';

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
   // Go's time.LoadLocation accepts this, so both servers must.
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
