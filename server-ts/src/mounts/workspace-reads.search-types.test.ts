import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseSearchTypes, SEARCH_TYPES } from './workspace-reads.ts';

test('an absent types parameter searches issues only, as it always has', () => {
   assert.deepEqual([...parseSearchTypes(null)], ['issue']);
   assert.deepEqual([...parseSearchTypes('')], ['issue']);
});

test('every advertised type is accepted, and duplicates collapse', () => {
   const parsed = parseSearchTypes(`${SEARCH_TYPES.join(',')},issue`);
   assert.deepEqual([...parsed].sort(), [...SEARCH_TYPES].sort());
});

test('whitespace around a type is tolerated', () => {
   assert.deepEqual([...parseSearchTypes(' project , agent ')].sort(), ['agent', 'project']);
});

test('an unknown type is refused rather than silently ignored', () => {
   assert.throws(() => parseSearchTypes('issue,initiative'));
});
