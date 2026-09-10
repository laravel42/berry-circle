import { Cron } from 'croner';
import { validTimezone } from '../http/validation.ts';

/**
 * When a schedule fires.
 *
 * Five fields only — minute, hour, day of month, month, day of week. croner
 * also reads a seconds field, and a schedule that fires every second would be
 * an agent task every second; the refusal is here rather than in the UI so an
 * API caller meets it too.
 *
 * The time zone is an IANA name and never `Local`: the server's own zone is a
 * deployment detail, and a schedule that moved when the host did would fire
 * at a time nobody chose.
 *
 * "Next" is always strictly after the moment asked about. The scheduler asks
 * "what comes after the slot I just claimed", and an answer equal to that
 * slot would claim it again forever.
 */

export const MAX_PREVIEW = 20;

export class InvalidSchedule extends Error {
   override readonly name = 'InvalidSchedule';
}

export function assertSchedule(expression: string, timezone: string): void {
   build(expression, timezone);
}

export function nextFireTimes(
   expression: string,
   timezone: string,
   from: Date,
   count: number
): Date[] {
   const n = Math.min(Math.max(1, Math.floor(Number.isFinite(count) ? count : 1)), MAX_PREVIEW);
   return build(expression, timezone).nextRuns(n, strictlyAfter(from));
}

export function nextFireAfter(expression: string, timezone: string, from: Date): Date | null {
   return build(expression, timezone).nextRun(strictlyAfter(from));
}

function build(expression: string, timezone: string): Cron {
   const trimmed = expression.trim();
   if (trimmed.split(/\s+/).length !== 5) {
      throw new InvalidSchedule(
         'A schedule has five fields: minute, hour, day of month, month and day of week.'
      );
   }
   if (timezone === 'Local' || !validTimezone(timezone)) {
      throw new InvalidSchedule('The time zone is not one this server knows.');
   }
   try {
      // Paused and without a callback: this instance is only ever asked
      // questions, and must never schedule a timer in the server process.
      return new Cron(trimmed, { timezone, paused: true });
   } catch (cause) {
      throw new InvalidSchedule('The schedule could not be read.', { cause });
   }
}

/**
 * One second past `from`. Every slot is on a whole minute, so this moves past
 * `from` when it is a slot and changes nothing when it is not — whichever way
 * croner treats its start date.
 */
function strictlyAfter(from: Date): Date {
   return new Date(from.getTime() + 1_000);
}
