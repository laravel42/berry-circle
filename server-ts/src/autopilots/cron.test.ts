import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvalidSchedule, MAX_PREVIEW, assertSchedule, nextFireAfter, nextFireTimes } from './cron.ts';

// 2026-09-10 is a Thursday. Rome is UTC+2 in September.
const THURSDAY_MIDNIGHT_UTC = new Date('2026-09-10T00:00:00.000Z');

test('a weekday-morning schedule fires at 09:00 in its own time zone, skipping the weekend', () => {
   const times = nextFireTimes('0 9 * * 1-5', 'Europe/Rome', THURSDAY_MIDNIGHT_UTC, 3);
   assert.deepEqual(
      times.map((time) => time.toISOString()),
      ['2026-09-10T07:00:00.000Z', '2026-09-11T07:00:00.000Z', '2026-09-14T07:00:00.000Z']
   );
});

test('the next firing is strictly after the moment asked about, even when that moment is a slot', () => {
   const next = nextFireAfter('0 9 * * *', 'UTC', new Date('2026-09-10T09:00:00.000Z'));
   assert.equal(next?.toISOString(), '2026-09-11T09:00:00.000Z');
});

test('a preview never lists more than the cap', () => {
   assert.equal(nextFireTimes('* * * * *', 'UTC', THURSDAY_MIDNIGHT_UTC, 500).length, MAX_PREVIEW);
   assert.equal(nextFireTimes('* * * * *', 'UTC', THURSDAY_MIDNIGHT_UTC, 0).length, 1);
});

test('a schedule with a seconds field is refused: autopilots fire at most once a minute', () => {
   assert.throws(() => assertSchedule('*/5 * * * * *', 'UTC'), InvalidSchedule);
});

test('an unknown or server-local time zone is refused', () => {
   assert.throws(() => assertSchedule('0 9 * * *', 'Mars/Olympus_Mons'), InvalidSchedule);
   assert.throws(() => assertSchedule('0 9 * * *', 'Local'), InvalidSchedule);
});

test('an expression croner cannot read is refused as a schedule, not a crash', () => {
   assert.throws(() => assertSchedule('99 * * * *', 'UTC'), InvalidSchedule);
   assert.throws(() => assertSchedule('every morning', 'UTC'), InvalidSchedule);
});
