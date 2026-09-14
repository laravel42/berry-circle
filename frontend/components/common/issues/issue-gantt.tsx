'use client';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import type { Issue } from '@/data/issues';
import { cn } from '@/lib/utils';
import { AlertTriangle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo, useState } from 'react';

const DAY = 86_400_000;

type Zoom = 'day' | 'week' | 'month';

/** Pixels one day takes at each zoom. */
const DAY_WIDTH: Record<Zoom, number> = { day: 28, week: 9, month: 3 };

const startOfDay = (time: number): number => {
   const date = new Date(time);
   date.setHours(0, 0, 0, 0);
   return date.getTime();
};

/**
 * Created-to-due bars on a time axis.
 *
 * A task whose due date falls before it started cannot be drawn as a span, and
 * silently swapping the ends would hide a real scheduling mistake — so those
 * are counted and called out instead.
 */
export function IssueGantt({ issues }: { issues: Issue[] }) {
   const t = useTranslations('issueLists');
   const { orgId } = useParams<{ orgId: string }>();
   const [zoom, setZoom] = useState<Zoom>('day');
   const [showCompleted, setShowCompleted] = useState(true);

   const visible = useMemo(
      () =>
         showCompleted
            ? issues
            : issues.filter(
                 (issue) =>
                    issue.status.category !== 'completed' && issue.status.category !== 'canceled'
              ),
      [issues, showCompleted]
   );

   const { dated, undated, inverted, start, days } = useMemo(() => {
      const withDue = visible.filter((issue) => issue.dueDate);
      const invertedRows = withDue.filter(
         (issue) => Date.parse(issue.dueDate ?? '') < Date.parse(issue.createdAt)
      );
      const starts = withDue.map((issue) => Date.parse(issue.createdAt));
      const ends = withDue.map((issue) => Date.parse(issue.dueDate ?? issue.createdAt));
      const today = Date.now();
      const first = startOfDay(Math.min(...[...starts, today]));
      const last = Math.max(...[...ends, today]);
      const span = Math.min(400, Math.max(14, Math.ceil((last - first) / DAY) + 2));
      return {
         dated: withDue,
         undated: visible.filter((issue) => !issue.dueDate),
         inverted: invertedRows,
         start: first,
         days: span,
      };
   }, [visible]);

   const width = days * DAY_WIDTH[zoom];
   const offsetOf = (time: number) => ((time - start) / DAY) * DAY_WIDTH[zoom];

   const weekendBands = useMemo(() => {
      if (zoom === 'month') return [];
      const bands: { left: number; width: number }[] = [];
      for (let index = 0; index < days; index += 1) {
         const day = new Date(start + index * DAY).getDay();
         if (day === 0 || day === 6) {
            bands.push({ left: index * DAY_WIDTH[zoom], width: DAY_WIDTH[zoom] });
         }
      }
      return bands;
   }, [days, start, zoom]);

   const todayLeft = offsetOf(startOfDay(Date.now()));

   return (
      <div className="flex h-full flex-col overflow-hidden">
         <div className="flex flex-wrap items-center gap-3 border-b px-4 py-1.5">
            <span className="text-muted-foreground">{t('gantt.zoom')}</span>
            <div className="flex items-center gap-1">
               {(['day', 'week', 'month'] as Zoom[]).map((option) => (
                  <Button
                     key={option}
                     size="xs"
                     variant={zoom === option ? 'secondary' : 'ghost'}
                     onClick={() => setZoom(option)}
                  >
                     {option === 'day'
                        ? t('gantt.day')
                        : option === 'week'
                          ? t('gantt.week')
                          : t('gantt.month')}
                  </Button>
               ))}
            </div>
            <div className="ml-auto flex items-center gap-2">
               <Label htmlFor="gantt-completed" className="font-normal text-muted-foreground">
                  {t('gantt.showCompleted')}
               </Label>
               <Switch
                  id="gantt-completed"
                  checked={showCompleted}
                  onCheckedChange={setShowCompleted}
               />
            </div>
         </div>

         {inverted.length > 0 ? (
            <div className="flex items-center gap-2 border-b bg-status-warning/10 px-4 py-1.5 text-status-warning">
               <AlertTriangle className="size-3.5 shrink-0" />
               {t('gantt.inverted', { count: inverted.length })}
            </div>
         ) : null}

         <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
            <div className="grid" style={{ gridTemplateColumns: `240px ${width}px` }}>
               <div className="sticky left-0 z-10 bg-container" />
               <div className="relative mb-2 h-5 text-muted-foreground">
                  <span className="absolute left-0">
                     {new Date(start).toISOString().slice(0, 10)}
                  </span>
                  <span className="absolute right-0">
                     {new Date(start + days * DAY).toISOString().slice(0, 10)}
                  </span>
               </div>

               {dated.map((issue) => {
                  const from = Date.parse(issue.createdAt);
                  const to = Date.parse(issue.dueDate ?? issue.createdAt);
                  const backwards = to < from;
                  const left = offsetOf(Math.min(from, to));
                  const span = Math.max(
                     DAY_WIDTH[zoom] / 2,
                     Math.abs(offsetOf(to) - offsetOf(from))
                  );
                  return (
                     <div key={issue.id} className="contents">
                        <Link
                           href={`/${orgId}/issue/${issue.identifier}`}
                           className="sticky left-0 z-10 truncate bg-container pr-3 hover:underline"
                        >
                           <span className="text-muted-foreground">{issue.identifier}</span>{' '}
                           {issue.title}
                        </Link>
                        <div className="relative h-6">
                           {weekendBands.map((band) => (
                              <div
                                 key={band.left}
                                 className="absolute inset-y-0 bg-muted/40"
                                 style={{ left: band.left, width: band.width }}
                              />
                           ))}
                           <div className="absolute inset-x-0 top-0.5 h-5 rounded bg-accent/40" />
                           <div
                              className={cn(
                                 'absolute top-0.5 h-5 rounded',
                                 backwards ? 'bg-status-danger/70' : 'bg-primary/70'
                              )}
                              style={{ left, width: span }}
                              title={`${issue.createdAt.slice(0, 10)} → ${issue.dueDate?.slice(0, 10) ?? ''}`}
                           />
                           <div
                              className="absolute inset-y-0 w-px bg-status-warning"
                              style={{ left: todayLeft }}
                              title={t('gantt.today')}
                           />
                        </div>
                     </div>
                  );
               })}
            </div>

            {undated.length > 0 ? (
               <div className="mt-6">
                  <div className="mb-1 text-muted-foreground">No due date ({undated.length})</div>
                  <ul className="flex flex-col gap-0.5">
                     {undated.map((issue) => (
                        <li key={issue.id}>
                           <Link
                              href={`/${orgId}/issue/${issue.identifier}`}
                              className="hover:underline"
                           >
                              <span className="text-muted-foreground">{issue.identifier}</span>{' '}
                              {issue.title}
                           </Link>
                        </li>
                     ))}
                  </ul>
               </div>
            ) : null}
         </div>
      </div>
   );
}
