import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toRFC3339 } from './pool.ts';

/**
 * These pin a bug that cost six hours per timestamp.
 *
 * PostgreSQL renders timestamptz in the session's timezone, so a host on
 * America/Mexico_City returns `2026-08-22 23:47:19.652293-06`. Replacing that
 * offset with `Z` keeps every digit and changes the instant — a corruption
 * that reads as a formatting choice.
 */

test('a UTC timestamp becomes RFC 3339 with its precision intact', () => {
   assert.equal(toRFC3339('2026-08-23 05:47:19.652293+00'), '2026-08-23T05:47:19.652293Z');
   assert.equal(toRFC3339('2026-08-23 05:47:19.652293Z'), '2026-08-23T05:47:19.652293Z');
   assert.equal(toRFC3339('2026-08-23 05:47:19+00'), '2026-08-23T05:47:19Z');
});

test('a non-UTC offset is converted, never stripped', () => {
   // The same instant, written three ways.
   assert.equal(toRFC3339('2026-08-22 23:47:19.652293-06'), '2026-08-23T05:47:19.652293Z');
   assert.equal(toRFC3339('2026-08-23 07:47:19.652293+02'), '2026-08-23T05:47:19.652293Z');
   assert.equal(toRFC3339('2026-08-23 11:17:19.652293+05:30'), '2026-08-23T05:47:19.652293Z');
});

test('microseconds survive a conversion that a Date would truncate', () => {
   const converted = toRFC3339('2026-08-22 23:47:19.652293-06');
   assert.ok(converted?.includes('.652293'), `lost precision: ${converted}`);
   // What the naive implementation produced, for contrast.
   assert.notEqual(converted, '2026-08-22T23:47:19.652293Z');
});

test('null and undefined stay absent rather than becoming an epoch', () => {
   assert.equal(toRFC3339(null), null);
   assert.equal(toRFC3339(undefined), null);
   assert.equal(toRFC3339(''), null);
});

test('an unrecognised timestamp is refused rather than guessed at', () => {
   // Silently returning something plausible is how the six-hour shift shipped.
   assert.throws(() => toRFC3339('not a timestamp'), /unrecognised timestamp/);
   assert.throws(() => toRFC3339('2026-08-23'), /unrecognised timestamp/);
});
