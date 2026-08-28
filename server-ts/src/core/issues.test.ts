import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import {
   apiStatusToDb,
   dbStatusToApi,
   escapeSearchLiteral,
   formatIdentifier,
   issueCursorScope,
   parseCanonicalUUID,
   parseIdentifier,
} from './issues.ts';

/**
 * Captured scopes for the same seven filters.
 *
 * A cursor is only valid for the query that produced it, and the scope is what
 * enforces that — so it is hashed over Go's `json.Marshal` of a struct:
 * declaration order, never sorted, and a nil slice is `null` where an empty
 * slice is `[]`. Getting any of that wrong would silently accept a cursor from
 * a different filter, returning a page that skips rows.
 */
const BOARD = '11111111-1111-4111-8111-111111111120';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const QUERY = '%needle%';

const GO_SCOPES: Record<string, string> = {
   'board only': 'issues.list.0978720ddeab47d7',
   statuses: 'issues.list.2eb84e899fec4d1e',
   priorities: 'issues.list.53e2b12fd2b1d4cc',
   assignee: 'issues.list.5d19e383e1383bb2',
   query: 'issues.list.d4c6cabb293d04b9',
   'empty statuses': 'issues.list.3c776e64b85399af',
   everything: 'issues.list.8711ee8a3b41549b',
};

const EMPTY = { statuses: null, priorities: null, assignee: null, query: null };

test('a cursor scope hashes to the same value Go produces', () => {
   const cases: Record<string, Parameters<typeof issueCursorScope>[0]> = {
      'board only': { boardId: BOARD, ...EMPTY },
      statuses: { boardId: BOARD, ...EMPTY, statuses: ['in_progress', 'todo'] },
      priorities: { boardId: BOARD, ...EMPTY, priorities: ['high', 'urgent'] },
      assignee: { boardId: BOARD, ...EMPTY, assignee: { type: 'agent', id: ACTOR } },
      query: { boardId: BOARD, ...EMPTY, query: QUERY },
      'empty statuses': { boardId: BOARD, ...EMPTY, statuses: [] },
      everything: {
         boardId: BOARD,
         statuses: ['done'],
         priorities: ['low'],
         assignee: { type: 'user', id: ACTOR },
         query: QUERY,
      },
   };
   for (const [name, filter] of Object.entries(cases)) {
      assert.equal(issueCursorScope(filter), GO_SCOPES[name], name);
   }
});

test('no filter and an empty filter are different scopes', () => {
   // Go marshals a nil slice as null and an empty slice as [], so these are
   // genuinely different queries and their cursors are not interchangeable.
   assert.notEqual(
      issueCursorScope({ boardId: BOARD, ...EMPTY }),
      issueCursorScope({ boardId: BOARD, ...EMPTY, statuses: [] })
   );
});

test('changing any part of the filter changes the scope', () => {
   const base = issueCursorScope({ boardId: BOARD, ...EMPTY });
   const variants = [
      { boardId: BOARD, ...EMPTY, statuses: ['todo'] },
      { boardId: BOARD, ...EMPTY, priorities: ['low'] },
      { boardId: BOARD, ...EMPTY, assignee: { type: 'user', id: ACTOR } },
      { boardId: BOARD, ...EMPTY, query: QUERY },
      { boardId: ACTOR, ...EMPTY },
   ];
   for (const variant of variants) assert.notEqual(issueCursorScope(variant), base);
});

test('statuses map between the wire and the enum', () => {
   assert.equal(apiStatusToDb('inProgress'), 'in_progress');
   assert.equal(apiStatusToDb('inReview'), 'in_review');
   assert.equal(apiStatusToDb('todo'), 'todo');
   assert.equal(dbStatusToApi('in_progress'), 'inProgress');
   assert.equal(dbStatusToApi('in_review'), 'inReview');
   assert.equal(dbStatusToApi('done'), 'done');
});

test('an identifier splits at its last hyphen', () => {
   assert.deepEqual(parseIdentifier('BER-57'), { prefix: 'BER', number: 57 });
   // A prefix containing a hyphen still resolves, because the number is the
   // part after the final one.
   assert.deepEqual(parseIdentifier('A-B-9'), { prefix: 'A-B', number: 9 });
});

test('an identifier that is not one is refused', () => {
   // Checked against Go's issueid.Parse for each of these.
   for (const value of ['BER', 'BER-', '-57', 'BER-0', 'BER-x', '', '-', 'BER-1.5']) {
      assert.equal(parseIdentifier(value), null, value);
   }
});

test('a doubled hyphen parses as a prefix ending in one, as Go parses it', () => {
   // `BER--5` splits at the *last* hyphen, so the number is 5 and the prefix
   // is "BER-". No workspace uses such a prefix, so it resolves to nothing —
   // but it parses, and the two servers must agree that it does.
   assert.deepEqual(parseIdentifier('BER--5'), { prefix: 'BER-', number: 5 });
});

test('only a canonical RFC 4122 UUID is treated as an id', () => {
   assert.equal(
      parseCanonicalUUID('11111111-1111-4111-8111-111111111120'),
      '11111111-1111-4111-8111-111111111120'
   );
   // Uppercase is canonical enough — Go compares case-insensitively.
   assert.equal(
      parseCanonicalUUID('11111111-1111-4111-8111-111111111120'.toUpperCase()),
      '11111111-1111-4111-8111-111111111120'
   );
   // The nil UUID, a non-RFC-4122 variant, and the brace and URN spellings all
   // fall through to identifier parsing rather than matching nothing.
   assert.equal(parseCanonicalUUID('00000000-0000-0000-0000-000000000000'), null);
   assert.equal(parseCanonicalUUID('11111111-1111-4111-c111-111111111120'), null);
   assert.equal(parseCanonicalUUID('{11111111-1111-4111-8111-111111111120}'), null);
   assert.equal(parseCanonicalUUID('urn:uuid:11111111-1111-4111-8111-111111111120'), null);
   assert.equal(parseCanonicalUUID('not-a-uuid'), null);
});

test('search wildcards are escaped so they match literally', () => {
   // Without this a search for "50%" would match every title.
   assert.equal(escapeSearchLiteral('50%'), String.raw`%50\%%`);
   assert.equal(escapeSearchLiteral('a_b'), String.raw`%a\_b%`);
   assert.equal(escapeSearchLiteral('back\\slash'), String.raw`%back\\slash%`);
   assert.equal(escapeSearchLiteral('plain'), '%plain%');
});

test('an identifier is formatted uppercase, as Go formats it', () => {
   assert.equal(formatIdentifier('ber', 57), 'BER-57');
   assert.equal(formatIdentifier('  BER  ', 1), 'BER-1');
});

test('the outbox envelope is inserted as an object, never a pre-serialised string', () => {
   // Passing text and casting it with ::jsonb stores a jsonb *string* — the
   // whole envelope quoted and escaped. Every consumer then fails to decode
   // it, and Go's workspace event stream answered 500 for two such rows.
   //
   // Asserted against the source because the mistake is in how the value
   // reaches the driver, which no unit test of the returned events can see.
   const source = readFileSync(new URL('./issues.ts', import.meta.url), 'utf8');
   const insert = source.slice(source.indexOf('INSERT INTO outbox_events'));
   const payloadParameter = insert.slice(0, insert.indexOf('::jsonb'));
   assert.ok(
      payloadParameter.includes('tx.json(envelope)'),
      'the envelope must be passed through the driver\'s json() helper'
   );
   assert.ok(
      !/const envelope = JSON\.stringify/.test(source),
      'the envelope must be built as an object, not stringified first'
   );
});
