/**
 * The schedule a person describes, and the cron the server stores.
 *
 * Berry keeps a five-field cron expression because that is what the scheduler
 * reads. Nobody should have to write one, so the editor works in the terms
 * people actually use — at nine, every two hours, weekdays only — and this
 * translates both ways.
 *
 * The translation is deliberately narrow. An expression this cannot describe is
 * not approximated: `fromCron` answers null, the editor locks to the raw field,
 * and the expression is left exactly as its author wrote it. Quietly rounding
 * someone's schedule to the nearest thing the controls can draw would change
 * when their agent runs.
 */

export type DaySelection =
   | { kind: 'every' }
   /** 0 is Sunday, as cron counts them. */
   | { kind: 'weekdays'; days: number[] }
   | { kind: 'monthDay'; day: number };

export interface VisualSchedule {
   mode: 'time' | 'everyHours' | 'everyMinutes';
   /** For `time`: when, in the schedule's own zone. */
   hour: number;
   minute: number;
   /** For the `every*` modes: the interval. */
   every: number;
   /** For the `every*` modes: only between these hours, or null for all day. */
   window: { from: number; to: number } | null;
   days: DaySelection;
}

export const DEFAULT_SCHEDULE: VisualSchedule = {
   mode: 'time',
   hour: 9,
   minute: 0,
   every: 2,
   window: null,
   days: { kind: 'every' },
};

function daysField(days: DaySelection): { dayOfMonth: string; weekday: string } {
   if (days.kind === 'weekdays' && days.days.length > 0) {
      return { dayOfMonth: '*', weekday: [...days.days].sort((a, b) => a - b).join(',') };
   }
   if (days.kind === 'monthDay') return { dayOfMonth: String(days.day), weekday: '*' };
   return { dayOfMonth: '*', weekday: '*' };
}

/** The expression this schedule means. */
export function toCron(schedule: VisualSchedule): string {
   const { dayOfMonth, weekday } = daysField(schedule.days);
   if (schedule.mode === 'time') {
      return `${schedule.minute} ${schedule.hour} ${dayOfMonth} * ${weekday}`;
   }
   const hours =
      schedule.window === null
         ? schedule.mode === 'everyHours'
            ? `*/${schedule.every}`
            : '*'
         : schedule.mode === 'everyHours'
           ? `${schedule.window.from}-${schedule.window.to}/${schedule.every}`
           : `${schedule.window.from}-${schedule.window.to}`;
   const minutes = schedule.mode === 'everyHours' ? String(schedule.minute) : `*/${schedule.every}`;
   return `${minutes} ${hours} ${dayOfMonth} * ${weekday}`;
}

const NUMBER = /^\d{1,2}$/;
const STEP = /^\*\/(\d{1,2})$/;
const RANGE_STEP = /^(\d{1,2})-(\d{1,2})\/(\d{1,2})$/;
const RANGE = /^(\d{1,2})-(\d{1,2})$/;

function readDays(dayOfMonth: string, weekday: string): DaySelection | null {
   if (dayOfMonth === '*' && weekday === '*') return { kind: 'every' };
   if (dayOfMonth === '*' && /^[0-6](,[0-6])*$/.test(weekday)) {
      return { kind: 'weekdays', days: [...new Set(weekday.split(',').map(Number))] };
   }
   if (weekday === '*' && NUMBER.test(dayOfMonth)) {
      const day = Number(dayOfMonth);
      if (day >= 1 && day <= 31) return { kind: 'monthDay', day };
   }
   return null;
}

/**
 * The schedule an expression describes, or null when the controls cannot draw
 * it faithfully — a step in the month field, a named weekday, a list of hours.
 */
export function fromCron(expression: string): VisualSchedule | null {
   const fields = expression.trim().split(/\s+/);
   if (fields.length !== 5) return null;
   const [minute, hour, dayOfMonth, month, weekday] = fields as [
      string,
      string,
      string,
      string,
      string,
   ];
   if (month !== '*') return null;
   const days = readDays(dayOfMonth, weekday);
   if (!days) return null;

   const minuteStep = STEP.exec(minute);
   if (minuteStep) {
      const every = Number(minuteStep[1]);
      if (every < 1 || every > 59) return null;
      if (hour === '*') {
         return { ...DEFAULT_SCHEDULE, mode: 'everyMinutes', every, window: null, days };
      }
      const window = RANGE.exec(hour);
      if (!window) return null;
      return {
         ...DEFAULT_SCHEDULE,
         mode: 'everyMinutes',
         every,
         window: { from: Number(window[1]), to: Number(window[2]) },
         days,
      };
   }

   if (!NUMBER.test(minute)) return null;
   const at = Number(minute);
   if (at > 59) return null;

   if (NUMBER.test(hour)) {
      const value = Number(hour);
      if (value > 23) return null;
      return { ...DEFAULT_SCHEDULE, mode: 'time', hour: value, minute: at, days };
   }

   const hourStep = STEP.exec(hour);
   if (hourStep) {
      const every = Number(hourStep[1]);
      if (every < 1 || every > 23) return null;
      return { ...DEFAULT_SCHEDULE, mode: 'everyHours', every, minute: at, window: null, days };
   }

   const windowed = RANGE_STEP.exec(hour);
   if (windowed) {
      const from = Number(windowed[1]);
      const to = Number(windowed[2]);
      const every = Number(windowed[3]);
      if (from > 23 || to > 23 || from > to || every < 1 || every > 23) return null;
      return {
         ...DEFAULT_SCHEDULE,
         mode: 'everyHours',
         every,
         minute: at,
         window: { from, to },
         days,
      };
   }

   return null;
}

/** The zones this browser knows, newest API first, falling back to the local one. */
export function knownTimezones(): string[] {
   const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] })
      .supportedValuesOf;
   if (typeof supported === 'function') {
      try {
         return supported('timeZone');
      } catch {
         /* Fall through to the local zone. */
      }
   }
   return [localTimezone()];
}

export function localTimezone(): string {
   return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** Weekday names in the reader's own language, Sunday first as cron counts. */
export function weekdayNames(locale: string): string[] {
   const format = new Intl.DateTimeFormat(locale, { weekday: 'short' });
   // 2024-01-07 was a Sunday; seven days from it name the week in order.
   return Array.from({ length: 7 }, (_, index) =>
      format.format(new Date(Date.UTC(2024, 0, 7 + index)))
   );
}

/** "in 2 h 5 min", "in 40 s", "now": how long until `when`. */
export function countdown(
   when: string,
   now: number = Date.now()
): { hours: number; minutes: number; seconds: number } {
   const left = Math.max(0, new Date(when).getTime() - now);
   return {
      hours: Math.floor(left / 3_600_000),
      minutes: Math.floor((left % 3_600_000) / 60_000),
      seconds: Math.floor((left % 60_000) / 1000),
   };
}
