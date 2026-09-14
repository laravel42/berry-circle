'use client';

import { Check, Globe } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
   Command,
   CommandGroup,
   CommandInput,
   CommandItem,
   CommandList,
} from '@/components/ui/command';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { describeAutopilotFailure, previewCron } from '@/lib/autopilots';
import {
   DEFAULT_SCHEDULE,
   countdown,
   fromCron,
   knownTimezones,
   localTimezone,
   toCron,
   weekdayNames,
   type VisualSchedule,
} from '@/lib/cron-schedule';
import { cn } from '@/lib/utils';

interface Props {
   /** The expression being edited; the editor never changes it on its own. */
   expression: string;
   timezone: string;
   onChange: (next: { expression: string; timezone: string }) => void;
}

/** The preview is a promise about the future; thirty seconds is close enough. */
const TICK_MS = 30_000;

/**
 * Says when an autopilot runs, in the words people use.
 *
 * Underneath it is still a five-field cron, and that field is one toggle away —
 * but an expression the visual controls cannot draw faithfully locks them
 * rather than being rounded to the nearest thing they can show. Rounding would
 * quietly change when someone's agent runs.
 */
export default function ScheduleEditor({ expression, timezone, onChange }: Props) {
   const t = useTranslations('areas.autopilots.schedule');
   const locale = useLocale();
   const [raw, setRaw] = useState(false);
   const [preview, setPreview] = useState<string[]>([]);
   const [problem, setProblem] = useState<string | null>(null);
   const [now, setNow] = useState(() => Date.now());

   const visual = useMemo(() => fromCron(expression), [expression]);
   const locked = visual === null;
   const schedule = visual ?? DEFAULT_SCHEDULE;
   const days = weekdayNames(locale);
   const zones = useMemo(knownTimezones, []);

   useEffect(() => {
      const timer = setTimeout(() => {
         void previewCron(expression, timezone, 5)
            .then((times) => {
               setPreview(times);
               setProblem(null);
            })
            .catch((failure: unknown) => {
               setPreview([]);
               setProblem(describeAutopilotFailure(failure));
            });
      }, 300);
      return () => clearTimeout(timer);
   }, [expression, timezone]);

   // The countdowns are only true for a moment, so they are re-read on a timer
   // rather than left to go stale on the screen.
   useEffect(() => {
      const timer = setInterval(() => setNow(Date.now()), TICK_MS);
      return () => clearInterval(timer);
   }, []);

   const set = (patch: Partial<VisualSchedule>) =>
      onChange({ expression: toCron({ ...schedule, ...patch }), timezone });

   const number = (value: string, min: number, max: number, fallback: number) => {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return fallback;
      return Math.min(max, Math.max(min, Math.round(parsed)));
   };

   return (
      <div className="flex flex-col gap-3">
         <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium">{t('title')}</span>
            <label className="flex items-center gap-2">
               <Switch
                  checked={raw || locked}
                  disabled={locked}
                  onCheckedChange={setRaw}
                  aria-label={t('rawToggle')}
               />
               <span className="text-muted-foreground">{t('rawToggle')}</span>
            </label>
         </div>

         {locked ? (
            <p className="rounded-md border border-dashed p-2 text-muted-foreground" role="status">
               {t('rawLocked')}
            </p>
         ) : null}

         {raw || locked ? (
            <div className="grid gap-1.5">
               <Label htmlFor="cron-expression">{t('expression')}</Label>
               <Input
                  id="cron-expression"
                  className="font-mono"
                  value={expression}
                  onChange={(event) => onChange({ expression: event.target.value, timezone })}
               />
            </div>
         ) : (
            <div className="flex flex-col gap-3">
               <div className="flex flex-wrap items-center gap-1">
                  {(['time', 'everyHours', 'everyMinutes'] as const).map((mode) => (
                     <Button
                        key={mode}
                        type="button"
                        size="xs"
                        variant={schedule.mode === mode ? 'secondary' : 'ghost'}
                        onClick={() => set({ mode })}
                     >
                        {t(`mode_${mode}`)}
                     </Button>
                  ))}
               </div>

               {schedule.mode === 'time' ? (
                  <div className="flex flex-wrap items-end gap-2">
                     <label className="grid gap-1.5">
                        <span className="text-muted-foreground">{t('hour')}</span>
                        <Input
                           className="h-7 w-20"
                           type="number"
                           min={0}
                           max={23}
                           value={schedule.hour}
                           onChange={(event) =>
                              set({ hour: number(event.target.value, 0, 23, schedule.hour) })
                           }
                        />
                     </label>
                     <label className="grid gap-1.5">
                        <span className="text-muted-foreground">{t('minute')}</span>
                        <Input
                           className="h-7 w-20"
                           type="number"
                           min={0}
                           max={59}
                           value={schedule.minute}
                           onChange={(event) =>
                              set({ minute: number(event.target.value, 0, 59, schedule.minute) })
                           }
                        />
                     </label>
                  </div>
               ) : (
                  <div className="flex flex-col gap-2">
                     <label className="flex flex-wrap items-center gap-2">
                        <span className="text-muted-foreground">{t('every')}</span>
                        <Input
                           className="h-7 w-20"
                           type="number"
                           min={1}
                           max={schedule.mode === 'everyHours' ? 23 : 59}
                           value={schedule.every}
                           onChange={(event) =>
                              set({
                                 every: number(
                                    event.target.value,
                                    1,
                                    schedule.mode === 'everyHours' ? 23 : 59,
                                    schedule.every
                                 ),
                              })
                           }
                        />
                        <span className="text-muted-foreground">
                           {schedule.mode === 'everyHours' ? t('hours') : t('minutes')}
                        </span>
                     </label>
                     <label className="flex items-center gap-2">
                        <Switch
                           checked={schedule.window !== null}
                           onCheckedChange={(on) =>
                              set({ window: on ? { from: 9, to: 17 } : null })
                           }
                           aria-label={t('window')}
                        />
                        <span className="text-muted-foreground">{t('window')}</span>
                     </label>
                     {schedule.window ? (
                        <div className="flex flex-wrap items-end gap-2">
                           <label className="grid gap-1.5">
                              <span className="text-muted-foreground">{t('from')}</span>
                              <Input
                                 className="h-7 w-20"
                                 type="number"
                                 min={0}
                                 max={23}
                                 value={schedule.window.from}
                                 onChange={(event) =>
                                    set({
                                       window: {
                                          from: number(
                                             event.target.value,
                                             0,
                                             23,
                                             schedule.window?.from ?? 9
                                          ),
                                          to: schedule.window?.to ?? 17,
                                       },
                                    })
                                 }
                              />
                           </label>
                           <label className="grid gap-1.5">
                              <span className="text-muted-foreground">{t('to')}</span>
                              <Input
                                 className="h-7 w-20"
                                 type="number"
                                 min={0}
                                 max={23}
                                 value={schedule.window.to}
                                 onChange={(event) =>
                                    set({
                                       window: {
                                          from: schedule.window?.from ?? 9,
                                          to: number(
                                             event.target.value,
                                             0,
                                             23,
                                             schedule.window?.to ?? 17
                                          ),
                                       },
                                    })
                                 }
                              />
                           </label>
                        </div>
                     ) : null}
                  </div>
               )}

               <div className="flex flex-col gap-2">
                  <span className="text-muted-foreground">{t('days')}</span>
                  <div className="flex flex-wrap items-center gap-1">
                     {(['every', 'weekdays', 'monthDay'] as const).map((kind) => (
                        <Button
                           key={kind}
                           type="button"
                           size="xs"
                           variant={schedule.days.kind === kind ? 'secondary' : 'ghost'}
                           onClick={() =>
                              set({
                                 days:
                                    kind === 'every'
                                       ? { kind: 'every' }
                                       : kind === 'weekdays'
                                         ? { kind: 'weekdays', days: [1, 2, 3, 4, 5] }
                                         : { kind: 'monthDay', day: 1 },
                              })
                           }
                        >
                           {t(`days_${kind}`)}
                        </Button>
                     ))}
                  </div>
                  {schedule.days.kind === 'weekdays' ? (
                     <div className="flex flex-wrap gap-1">
                        {days.map((label, index) => {
                           const chosen =
                              schedule.days.kind === 'weekdays' &&
                              schedule.days.days.includes(index);
                           return (
                              <Button
                                 key={label}
                                 type="button"
                                 size="xxs"
                                 variant={chosen ? 'secondary' : 'ghost'}
                                 className={cn('min-w-10', chosen && 'font-medium')}
                                 onClick={() => {
                                    if (schedule.days.kind !== 'weekdays') return;
                                    const next = chosen
                                       ? schedule.days.days.filter((day) => day !== index)
                                       : [...schedule.days.days, index];
                                    set({
                                       days:
                                          next.length === 0
                                             ? { kind: 'every' }
                                             : { kind: 'weekdays', days: next },
                                    });
                                 }}
                              >
                                 {label}
                              </Button>
                           );
                        })}
                     </div>
                  ) : null}
                  {schedule.days.kind === 'monthDay' ? (
                     <label className="grid w-28 gap-1.5">
                        <span className="text-muted-foreground">{t('dayOfMonth')}</span>
                        <Input
                           className="h-7"
                           type="number"
                           min={1}
                           max={31}
                           value={schedule.days.day}
                           onChange={(event) =>
                              set({
                                 days: {
                                    kind: 'monthDay',
                                    day: number(
                                       event.target.value,
                                       1,
                                       31,
                                       schedule.days.kind === 'monthDay' ? schedule.days.day : 1
                                    ),
                                 },
                              })
                           }
                        />
                     </label>
                  ) : null}
               </div>
            </div>
         )}

         <div className="grid gap-1.5">
            <span className="text-muted-foreground">{t('timezone')}</span>
            <Popover>
               <PopoverTrigger asChild>
                  <Button type="button" size="xs" variant="outline" className="w-fit">
                     <Globe className="mr-1 size-4" />
                     {timezone}
                  </Button>
               </PopoverTrigger>
               <PopoverContent className="w-72 p-0" align="start">
                  <Command>
                     <CommandInput placeholder={t('searchZones')} />
                     <CommandList>
                        <CommandGroup>
                           <CommandItem
                              value={localTimezone()}
                              onSelect={() => onChange({ expression, timezone: localTimezone() })}
                              className="justify-between"
                           >
                              {localTimezone()}
                              {timezone === localTimezone() ? <Check className="size-4" /> : null}
                           </CommandItem>
                           {zones.map((zone) => (
                              <CommandItem
                                 key={zone}
                                 value={zone}
                                 onSelect={() => onChange({ expression, timezone: zone })}
                                 className="justify-between"
                              >
                                 {zone}
                                 {timezone === zone ? <Check className="size-4" /> : null}
                              </CommandItem>
                           ))}
                        </CommandGroup>
                     </CommandList>
                  </Command>
               </PopoverContent>
            </Popover>
         </div>

         <div className="rounded-md border p-3">
            <p className="font-medium">{t('preview')}</p>
            {problem ? (
               <p className="text-destructive" role="alert">
                  {problem}
               </p>
            ) : preview.length === 0 ? (
               <p className="text-muted-foreground">{t('previewEmpty')}</p>
            ) : (
               <ul className="mt-1 flex flex-col gap-0.5">
                  {preview.map((time) => {
                     const left = countdown(time, now);
                     return (
                        <li key={time} className="flex justify-between gap-3">
                           <span>{new Date(time).toLocaleString()}</span>
                           <span className="text-muted-foreground">
                              {t('inTime', { hours: left.hours, minutes: left.minutes })}
                           </span>
                        </li>
                     );
                  })}
               </ul>
            )}
         </div>
      </div>
   );
}
