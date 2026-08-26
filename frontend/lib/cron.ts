/**
 * Five-field cron for schedule triggers: the grammar the server accepts
 * (minute hour day-of-month month day-of-week, lists, ranges and steps,
 * digits only, plus the `@hourly` … `@yearly` aliases), a reading of it in
 * words, and the handful of presets a builder offers before it falls back
 * to the raw expression. Timezones are IANA names, checked with the
 * browser's own tables. Nothing here touches the network or React.
 */

export const CRON_ALIASES: Record<string, string> = {
   '@hourly': '0 * * * *',
   '@daily': '0 0 * * *',
   '@weekly': '0 0 * * 0',
   '@monthly': '0 0 1 * *',
   '@yearly': '0 0 1 1 *',
};

const FIELDS = [
   { name: 'minute', min: 0, max: 59 },
   { name: 'hour', min: 0, max: 23 },
   { name: 'day of month', min: 1, max: 31 },
   { name: 'month', min: 1, max: 12 },
   { name: 'day of week', min: 0, max: 7 },
] as const;

const FIELD_PATTERN = /^[0-9*,/-]+$/;

export interface CronField {
   raw: string;
   /** True when the field is `*` alone: unrestricted. */
   star: boolean;
   /** N for a field written as a star over N (every N minutes, hours…), or null. */
   everyStep: number | null;
   /** Every value the field admits, ascending. Day 7 is folded into 0. */
   values: number[];
}

export interface ParsedCron {
   /** The expression with aliases expanded and whitespace normalised. */
   expression: string;
   fields: [CronField, CronField, CronField, CronField, CronField];
}

function parseField(
   raw: string,
   spec: (typeof FIELDS)[number]
): { field: CronField } | { error: string } {
   if (!FIELD_PATTERN.test(raw)) {
      return { error: `The ${spec.name} field allows digits, "*", ",", "-" and "/" only.` };
   }
   const values = new Set<number>();
   let star = false;
   let everyStep: number | null = null;
   for (const item of raw.split(',')) {
      if (item === '') return { error: `The ${spec.name} field has an empty entry.` };
      const [range, stepText, extra] = item.split('/');
      if (extra !== undefined) return { error: `The ${spec.name} field has a stray "/".` };
      let step = 1;
      if (stepText !== undefined) {
         if (!/^\d+$/.test(stepText) || Number(stepText) === 0) {
            return { error: `A step in the ${spec.name} field is a positive number.` };
         }
         step = Number(stepText);
      }
      let low: number;
      let high: number;
      if (range === '*') {
         low = spec.min;
         high = spec.max;
         if (stepText === undefined) star = true;
         else if (raw === item) everyStep = step;
      } else {
         const [lowText, highText, more] = range.split('-');
         if (
            more !== undefined ||
            !/^\d+$/.test(lowText) ||
            (highText !== undefined && !/^\d+$/.test(highText))
         ) {
            return { error: `The ${spec.name} field has a value that is not a number or range.` };
         }
         low = Number(lowText);
         high =
            highText === undefined ? (stepText === undefined ? low : spec.max) : Number(highText);
         if (low < spec.min || low > spec.max || high < spec.min || high > spec.max) {
            return { error: `The ${spec.name} field is between ${spec.min} and ${spec.max}.` };
         }
         if (high < low) return { error: `A range in the ${spec.name} field runs backwards.` };
      }
      for (let value = low; value <= high; value += step) {
         values.add(spec.name === 'day of week' && value === 7 ? 0 : value);
      }
   }
   const list = Array.from(values).sort((a, b) => a - b);
   return { field: { raw, star: star && raw === '*', everyStep, values: list } };
}

/** The expression parsed, or the first thing wrong with it. */
export function parseCron(
   text: string
): { ok: true; cron: ParsedCron } | { ok: false; error: string } {
   let trimmed = text.trim();
   if (trimmed === '') return { ok: false, error: 'Give a schedule.' };
   if (trimmed.startsWith('@')) {
      const alias = CRON_ALIASES[trimmed];
      if (!alias) {
         return { ok: false, error: 'Aliases are @hourly, @daily, @weekly, @monthly and @yearly.' };
      }
      trimmed = alias;
   }
   const parts = trimmed.split(/\s+/);
   if (parts.length !== 5) {
      return {
         ok: false,
         error: 'A cron expression has five fields: minute hour day-of-month month day-of-week.',
      };
   }
   const fields: CronField[] = [];
   for (const [index, part] of parts.entries()) {
      const result = parseField(part, FIELDS[index]);
      if ('error' in result) return { ok: false, error: result.error };
      fields.push(result.field);
   }
   return {
      ok: true,
      cron: {
         expression: parts.join(' '),
         fields: fields as ParsedCron['fields'],
      },
   };
}

/** What is wrong with the expression, or null when the server would accept it. */
export function cronProblem(text: string): string | null {
   const parsed = parseCron(text);
   return parsed.ok ? null : parsed.error;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
   'January',
   'February',
   'March',
   'April',
   'May',
   'June',
   'July',
   'August',
   'September',
   'October',
   'November',
   'December',
];

export const WEEKDAY_OPTIONS = WEEKDAYS.map((label, value) => ({ value, label }));

function pad(value: number): string {
   return value.toString().padStart(2, '0');
}

function clock(hour: number, minute: number): string {
   return `${pad(hour)}:${pad(minute)}`;
}

function ordinal(day: number): string {
   const rest = day % 100;
   if (rest >= 11 && rest <= 13) return `${day}th`;
   switch (day % 10) {
      case 1:
         return `${day}st`;
      case 2:
         return `${day}nd`;
      case 3:
         return `${day}rd`;
      default:
         return `${day}th`;
   }
}

function joinNames(names: string[]): string {
   if (names.length <= 1) return names.join('');
   return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function single(field: CronField): number | null {
   return !field.star && field.values.length === 1 ? field.values[0] : null;
}

const WEEKDAY_VALUES = [1, 2, 3, 4, 5];
const WEEKEND_VALUES = [0, 6];

function sameValues(left: number[], right: number[]): boolean {
   return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * "Every day at 09:00", "Every weekday at 17:30", "Every Monday at 09:00",
 * "Every hour", "Every 15 minutes", "On the 1st of every month at 08:00";
 * anything the words do not cover is shown as the expression itself.
 */
export function describeCron(text: string, timezone?: string | null): string {
   const parsed = parseCron(text);
   const suffix = timezone ? ` · ${timezone}` : '';
   if (!parsed.ok) return `${text.trim() || 'no schedule'}${suffix}`;
   const [minute, hour, day, month, weekday] = parsed.cron.fields;
   const minuteAt = single(minute);
   const hourAt = single(hour);
   let words: string | null = null;
   if (minute.star && hour.star && day.star && month.star && weekday.star) {
      words = 'Every minute';
   } else if (minute.everyStep && hour.star && day.star && month.star && weekday.star) {
      words = `Every ${minute.everyStep} minutes`;
   } else if (minuteAt !== null && hour.star && day.star && month.star && weekday.star) {
      words = minuteAt === 0 ? 'Every hour' : `Every hour at :${pad(minuteAt)}`;
   } else if (minuteAt !== null && hour.everyStep && day.star && month.star && weekday.star) {
      words = `Every ${hour.everyStep} hours${minuteAt === 0 ? '' : ` at :${pad(minuteAt)}`}`;
   } else if (minuteAt !== null && hourAt !== null) {
      const time = clock(hourAt, minuteAt);
      const dayAt = single(day);
      const monthAt = single(month);
      if (day.star && month.star) {
         if (weekday.star) words = `Every day at ${time}`;
         else if (sameValues(weekday.values, WEEKDAY_VALUES)) words = `Every weekday at ${time}`;
         else if (sameValues(weekday.values, WEEKEND_VALUES))
            words = `Every weekend day at ${time}`;
         else
            words = `Every ${joinNames(weekday.values.map((value) => WEEKDAYS[value]))} at ${time}`;
      } else if (dayAt !== null && weekday.star) {
         if (month.star) words = `On the ${ordinal(dayAt)} of every month at ${time}`;
         else if (monthAt !== null)
            words = `Every year on ${dayAt} ${MONTHS[monthAt - 1]} at ${time}`;
      }
   }
   return `${words ?? `cron ${parsed.cron.expression}`}${suffix}`;
}

// ---------------------------------------------------------------------------
// The builder's presets

export type SchedulePreset = 'every_minute' | 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'custom';

export const SCHEDULE_PRESETS: { value: SchedulePreset; label: string; hint: string }[] = [
   { value: 'hourly', label: 'Every hour', hint: 'At a minute past each hour' },
   { value: 'daily', label: 'Every day at', hint: 'One time a day' },
   { value: 'weekdays', label: 'Every weekday at', hint: 'Monday to Friday' },
   { value: 'weekly', label: 'Every week on', hint: 'One day a week' },
   { value: 'every_minute', label: 'Every minute', hint: 'For trying a workflow out' },
   { value: 'custom', label: 'Custom cron', hint: 'Five fields, as on a server' },
];

export interface ScheduleDraft {
   preset: SchedulePreset;
   hour: number;
   minute: number;
   weekday: number;
   /** The expression as typed for the custom preset; derived for the others. */
   cron: string;
}

export function buildCron(draft: ScheduleDraft): string {
   switch (draft.preset) {
      case 'every_minute':
         return '* * * * *';
      case 'hourly':
         return `${draft.minute} * * * *`;
      case 'daily':
         return `${draft.minute} ${draft.hour} * * *`;
      case 'weekdays':
         return `${draft.minute} ${draft.hour} * * 1-5`;
      case 'weekly':
         return `${draft.minute} ${draft.hour} * * ${draft.weekday}`;
      case 'custom':
         return draft.cron;
   }
}

/** The preset an expression came from, so a stored schedule opens on its own controls. */
export function scheduleDraftFromCron(text: string): ScheduleDraft {
   const base: ScheduleDraft = { preset: 'custom', hour: 9, minute: 0, weekday: 1, cron: text };
   const parsed = parseCron(text);
   if (!parsed.ok) return base;
   const [minute, hour, day, month, weekday] = parsed.cron.fields;
   const minuteAt = single(minute);
   const hourAt = single(hour);
   if (!day.star || !month.star) return base;
   if (minute.star && hour.star && weekday.star) return { ...base, preset: 'every_minute' };
   if (minuteAt === null) return base;
   if (hour.star && weekday.star) return { ...base, preset: 'hourly', minute: minuteAt };
   if (hourAt === null) return base;
   if (weekday.star) return { ...base, preset: 'daily', hour: hourAt, minute: minuteAt };
   if (sameValues(weekday.values, WEEKDAY_VALUES)) {
      return { ...base, preset: 'weekdays', hour: hourAt, minute: minuteAt };
   }
   const weekdayAt = single(weekday);
   if (weekdayAt !== null) {
      return { ...base, preset: 'weekly', hour: hourAt, minute: minuteAt, weekday: weekdayAt };
   }
   return base;
}

// ---------------------------------------------------------------------------
// Timezones

const FALLBACK_TIMEZONES = [
   'UTC',
   'Europe/London',
   'Europe/Paris',
   'Europe/Berlin',
   'Europe/Rome',
   'Europe/Madrid',
   'America/New_York',
   'America/Chicago',
   'America/Denver',
   'America/Los_Angeles',
   'America/Sao_Paulo',
   'Asia/Tokyo',
   'Asia/Shanghai',
   'Asia/Kolkata',
   'Asia/Singapore',
   'Australia/Sydney',
];

/** The browser's own timezone, or UTC when it will not say. */
export function browserTimezone(): string {
   try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
   } catch {
      return 'UTC';
   }
}

let cachedTimezones: string[] | null = null;

/** Every IANA name the browser knows, the browser's own included, sorted. */
export function timezoneOptions(): string[] {
   if (cachedTimezones) return cachedTimezones;
   let names: string[] = FALLBACK_TIMEZONES;
   try {
      const supported = Intl.supportedValuesOf('timeZone');
      if (supported.length > 0) names = supported;
   } catch {
      // An older engine: the short list will do.
   }
   const set = new Set(names);
   set.add('UTC');
   set.add(browserTimezone());
   cachedTimezones = Array.from(set).sort((a, b) => a.localeCompare(b));
   return cachedTimezones;
}

/** True when the browser can format dates in the zone, which is what the server checks too. */
export function isValidTimezone(name: string): boolean {
   if (!name || name === 'Local') return false;
   try {
      new Intl.DateTimeFormat('en-US', { timeZone: name });
      return true;
   } catch {
      return false;
   }
}

/** What is wrong with a schedule trigger's config, or null when the server would accept it. */
export function scheduleProblem(value: {
   cron?: string | null;
   timezone?: string | null;
}): string | null {
   const cron = cronProblem(value.cron ?? '');
   if (cron) return cron;
   if (!isValidTimezone(value.timezone ?? '')) return 'Pick an IANA timezone.';
   return null;
}

/** "26 Aug 10:18" on the zone's wall clock, for a schedule's fire instant. */
export function formatInstant(iso: string, timezone?: string | null): string {
   const date = new Date(iso);
   if (Number.isNaN(date.getTime())) return iso;
   try {
      return new Intl.DateTimeFormat('en-GB', {
         day: 'numeric',
         month: 'short',
         hour: '2-digit',
         minute: '2-digit',
         hour12: false,
         timeZone: timezone && isValidTimezone(timezone) ? timezone : undefined,
      })
         .format(date)
         .replace(',', '');
   } catch {
      return iso;
   }
}
