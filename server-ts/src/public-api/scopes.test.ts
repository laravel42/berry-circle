import assert from 'node:assert/strict';
import { test } from 'node:test';
import { API_SCOPES, grants, isApiScope, parseScopes } from './scopes.ts';

test('parseScopes accepts known scopes, sorted and without duplicates', () => {
   assert.deepEqual(parseScopes(['issues:write', 'comments:read', 'issues:write']), [
      'comments:read',
      'issues:write',
   ]);
   assert.deepEqual(parseScopes([]), []);
});

test('parseScopes refuses anything that is not a list of known scopes', () => {
   assert.equal(parseScopes(['issues:admin']), null);
   assert.equal(parseScopes('issues:read'), null);
   assert.equal(parseScopes([1]), null);
});

test('a null scope list grants everything; a list grants only what it names', () => {
   for (const scope of API_SCOPES) assert.equal(grants(null, scope), true);
   assert.equal(grants(['issues:read'], 'issues:read'), true);
   assert.equal(grants(['issues:read'], 'issues:write'), false);
   assert.equal(isApiScope('storage:write'), true);
   assert.equal(isApiScope('storage'), false);
});
