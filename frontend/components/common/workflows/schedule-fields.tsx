'use client';

import { Button } from '@/components/ui/button';
import {
   Command,
   CommandEmpty,
   CommandGroup,
   CommandInput,
   CommandItem,
   CommandList,
} from '@/components/ui/command';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
   Select,
   SelectContent,
   SelectItem,
   SelectTrigger,
   SelectValue,
} from '@/components/ui/select';
import {
   SCHEDULE_PRESETS,
   WEEKDAY_OPTIONS,
   browserTimezone,
   buildCron,
   cronProblem,
   describeCron,
   scheduleDraftFromCron,
   scheduleProblem,
   timezoneOptions,
   type ScheduleDraft,
   type SchedulePreset,
} from '@/lib/cron';
import { cn } from '@/lib/utils';
import { Check, ChevronsUpDown, Globe } from 'lucide-react';
import { useId, useMemo, useState } from 'react';

export interface ScheduleValue {
   cron: string;
   timezone: string;
}

/** A fresh schedule: nine every weekday, on the browser's clock. */
export function defaultSchedule(): ScheduleValue {
   return { cron: '0 9 * * 1-5', timezone: browserTimezone() };
}

export { scheduleProblem };

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const MINUTES = Array.from({ length: 12 }, (_, index) => index * 5);

function pad(value: number): string {
   return value.toString().padStart(2, '0');
}

function NumberSelect({
   value,
   options,
   onChange,
   label,
}: {
   value: number;
   options: number[];
   onChange: (value: number) => void;
   label: string;
}) {
   const list = options.includes(value) ? options : [...options, value].sort((a, b) => a - b);
   return (
      <Select value={String(value)} onValueChange={(next) => onChange(Number(next))}>
         <SelectTrigger className="h-8 w-20" aria-label={label}>
            <SelectValue />
         </SelectTrigger>
         <SelectContent>
            {list.map((option) => (
               <SelectItem key={option} value={String(option)}>
                  {pad(option)}
               </SelectItem>
            ))}
         </SelectContent>
      </Select>
   );
}

/** An IANA timezone, searched by name, the browser's own marked. */
export function TimezonePicker({
   value,
   onChange,
   className,
}: {
   value: string;
   onChange: (value: string) => void;
   className?: string;
}) {
   const [open, setOpen] = useState(false);
   const zones = useMemo(() => timezoneOptions(), []);
   const mine = browserTimezone();
   return (
      <Popover open={open} onOpenChange={setOpen}>
         <PopoverTrigger asChild>
            <Button
               type="button"
               variant="outline"
               size="sm"
               role="combobox"
               aria-expanded={open}
               aria-label="Timezone"
               className={cn('h-8 justify-between font-normal', className)}
            >
               <span className="flex min-w-0 items-center gap-1.5">
                  <Globe className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="truncate">{value || 'Pick a timezone'}</span>
               </span>
               <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            </Button>
         </PopoverTrigger>
         <PopoverContent className="w-72 p-0" align="start">
            <Command>
               <CommandInput placeholder="Search timezones" />
               <CommandList className="max-h-64">
                  <CommandEmpty>No timezone matches.</CommandEmpty>
                  <CommandGroup>
                     {zones.map((zone) => (
                        <CommandItem
                           key={zone}
                           value={zone}
                           onSelect={() => {
                              onChange(zone);
                              setOpen(false);
                           }}
                        >
                           <Check
                              className={cn(
                                 'size-3.5',
                                 zone === value ? 'opacity-100' : 'opacity-0'
                              )}
                              aria-hidden
                           />
                           <span className="min-w-0 flex-1 truncate">{zone}</span>
                           {zone === mine && (
                              <span className="shrink-0 text-muted-foreground">your browser</span>
                           )}
                        </CommandItem>
                     ))}
                  </CommandGroup>
               </CommandList>
            </Command>
         </PopoverContent>
      </Popover>
   );
}

interface ScheduleFieldsProps {
   value: ScheduleValue;
   onChange: (value: ScheduleValue) => void;
   /** Stack the controls, for a narrow panel. */
   compact?: boolean;
}

/**
 * A schedule as a person would say it — every hour, every day at, every
 * weekday at, one day a week — with the raw five-field cron a click away
 * for anything else. Whatever is chosen is shown back in words with its
 * timezone, so a mistake reads as one before it is saved.
 */
export function ScheduleFields({ value, onChange, compact = false }: ScheduleFieldsProps) {
   const [draft, setDraft] = useState<ScheduleDraft>(() => scheduleDraftFromCron(value.cron));
   const cronId = useId();
   const problem = cronProblem(value.cron);

   const update = (patch: Partial<ScheduleDraft>) => {
      const next = { ...draft, ...patch };
      if (next.preset !== 'custom') next.cron = buildCron(next);
      setDraft(next);
      onChange({ cron: next.cron, timezone: value.timezone });
   };

   const setPreset = (preset: SchedulePreset) => {
      update({ preset, cron: preset === 'custom' ? value.cron : draft.cron });
   };

   const timed =
      draft.preset === 'daily' || draft.preset === 'weekdays' || draft.preset === 'weekly';

   return (
      <div className="flex min-w-0 flex-col gap-3">
         <div className={cn('grid gap-3', !compact && 'sm:grid-cols-2')}>
            <div className="flex min-w-0 flex-col gap-1">
               <Label className="text-muted-foreground">Repeats</Label>
               <Select
                  value={draft.preset}
                  onValueChange={(next) => setPreset(next as SchedulePreset)}
               >
                  <SelectTrigger className="h-8 w-full">
                     <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                     {SCHEDULE_PRESETS.map((preset) => (
                        <SelectItem key={preset.value} value={preset.value}>
                           {preset.label}
                        </SelectItem>
                     ))}
                  </SelectContent>
               </Select>
            </div>
            <div className="flex min-w-0 flex-col gap-1">
               <Label className="text-muted-foreground">Timezone</Label>
               <TimezonePicker
                  value={value.timezone}
                  onChange={(timezone) => onChange({ cron: value.cron, timezone })}
                  className="w-full"
               />
            </div>
         </div>

         {draft.preset === 'weekly' && (
            <div className="flex min-w-0 flex-col gap-1">
               <Label className="text-muted-foreground">Day</Label>
               <Select
                  value={String(draft.weekday)}
                  onValueChange={(next) => update({ weekday: Number(next) })}
               >
                  <SelectTrigger className="h-8 w-full sm:w-48">
                     <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                     {WEEKDAY_OPTIONS.map((day) => (
                        <SelectItem key={day.value} value={String(day.value)}>
                           {day.label}
                        </SelectItem>
                     ))}
                  </SelectContent>
               </Select>
            </div>
         )}

         {(timed || draft.preset === 'hourly') && (
            <div className="flex min-w-0 flex-col gap-1">
               <Label className="text-muted-foreground">
                  {draft.preset === 'hourly' ? 'At minute' : 'At'}
               </Label>
               <div className="flex items-center gap-1.5">
                  {timed && (
                     <>
                        <NumberSelect
                           value={draft.hour}
                           options={HOURS}
                           onChange={(hour) => update({ hour })}
                           label="Hour"
                        />
                        <span className="text-muted-foreground">:</span>
                     </>
                  )}
                  <NumberSelect
                     value={draft.minute}
                     options={MINUTES}
                     onChange={(minute) => update({ minute })}
                     label="Minute"
                  />
               </div>
            </div>
         )}

         {draft.preset === 'custom' ? (
            <div className="flex min-w-0 flex-col gap-1">
               <Label htmlFor={cronId} className="text-muted-foreground">
                  Cron expression
               </Label>
               <Input
                  id={cronId}
                  value={value.cron}
                  onChange={(event) => update({ cron: event.target.value })}
                  placeholder="0 9 * * 1-5"
                  className={cn('h-8 font-mono', problem && 'border-status-danger/60')}
                  aria-invalid={problem ? true : undefined}
               />
               <p
                  className={cn(problem ? 'text-status-danger' : 'text-muted-foreground')}
                  role="status"
               >
                  {problem ??
                     'minute hour day-of-month month day-of-week; lists, ranges and steps; or @hourly, @daily, @weekly, @monthly, @yearly.'}
               </p>
            </div>
         ) : (
            <p className="text-muted-foreground">
               <code className="font-mono">{value.cron}</code>
            </p>
         )}

         <p className="flex flex-wrap items-center gap-x-1.5" role="status">
            <span className="font-medium">{describeCron(value.cron, value.timezone)}</span>
            {draft.preset === 'every_minute' && (
               <span className="text-status-warning">— a run every minute while active.</span>
            )}
         </p>
      </div>
   );
}
