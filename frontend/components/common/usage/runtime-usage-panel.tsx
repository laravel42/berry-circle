'use client';

import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import {
   formatCost,
   formatTokens,
   getRuntimeUsage,
   type UsageBucket,
   type UsageQuery,
} from '@/lib/usage';
import { cn } from '@/lib/utils';
import { useSessionStore } from '@/store/session-store';

import { UsageBreakdownTable } from './usage-breakdown-table';
import { UsageDailyChart } from './usage-daily-chart';
import { UsageTiles } from './usage-tiles';
import { useUsage } from './use-usage';

/** Half a year of days, drawn as weeks. */
const HEATMAP_WEEKS = 26;

/**
 * A day's place in the heatmap and how hot it is, on a scale of five so the
 * quietest day that had any spend is still visible against an empty one.
 */
function heat(value: number, busiest: number): number {
   if (value <= 0) return 0;
   if (busiest <= 0) return 1;
   return Math.min(4, Math.ceil((value / busiest) * 4));
}

const SHADES = ['bg-muted/40', 'bg-primary/20', 'bg-primary/40', 'bg-primary/60', 'bg-primary/80'];

function Heatmap({ daily }: { daily: UsageBucket[] }) {
   const t = useTranslations('areas.usage.runtime');
   const days = daily.slice(-HEATMAP_WEEKS * 7);
   const busiest = Math.max(0, ...days.map((day) => day.costMicros));
   const weeks: UsageBucket[][] = [];
   for (let index = 0; index < days.length; index += 7) weeks.push(days.slice(index, index + 7));

   return (
      <div className="flex flex-col gap-1.5">
         <div className="flex gap-1 overflow-x-auto" role="img" aria-label={t('heatmap')}>
            {weeks.map((week) => (
               <div key={week[0]?.key ?? Math.random()} className="flex flex-col gap-1">
                  {week.map((day) => (
                     <span
                        key={day.key}
                        title={`${day.key}: ${formatCost(day.costMicros)}`}
                        className={cn(
                           'size-3 rounded-[2px]',
                           SHADES[heat(day.costMicros, busiest)]
                        )}
                     />
                  ))}
               </div>
            ))}
         </div>
         <p className="text-muted-foreground">{t('heatmapHint', { weeks: weeks.length })}</p>
      </div>
   );
}

/**
 * One runtime's usage: what it cost by day and hour, who spent it, on what
 * model, and a half-year at a glance.
 */
export function RuntimeUsagePanel({ runtimeId, query }: { runtimeId: string; query: UsageQuery }) {
   const t = useTranslations('areas.usage.runtime');
   const { orgId } = useParams<{ orgId: string }>();
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? null);
   const [split, setSplit] = useState<'agent' | 'model'>('agent');

   const { data, error } = useUsage(
      workspaceId ? () => getRuntimeUsage(workspaceId, runtimeId, query) : null,
      `${workspaceId}:${runtimeId}:${query.days}:${query.timezone ?? ''}`
   );
   if (error) return <p className="text-muted-foreground">{error}</p>;
   if (!data) return <p className="text-muted-foreground">{t('loading')}</p>;

   return (
      <div className="flex flex-col gap-6">
         <UsageTiles totals={data.totals} runs={data.runs} />

         <div className="grid gap-6 lg:grid-cols-2">
            <div>
               <h3 className="mb-2 font-medium">{t('byDay')}</h3>
               <UsageDailyChart points={data.daily} metric="cost" />
            </div>
            <div>
               <h3 className="mb-2 font-medium">{t('byHour', { zone: data.timezone })}</h3>
               <UsageDailyChart points={data.byHour} metric="tokens" />
            </div>
         </div>

         <section className="flex flex-col gap-2">
            <h3 className="font-medium">{t('heatmap')}</h3>
            <Heatmap daily={data.daily} />
         </section>

         <section className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
               <h3 className="mr-auto font-medium">{t('split')}</h3>
               <div className="flex items-center gap-1 rounded-md border p-0.5">
                  {(['agent', 'model'] as const).map((option) => (
                     <Button
                        key={option}
                        size="xxs"
                        variant={split === option ? 'secondary' : 'ghost'}
                        onClick={() => setSplit(option)}
                     >
                        {t(`by_${option}`)}
                     </Button>
                  ))}
               </div>
            </div>
            <UsageBreakdownTable
               title={split === 'agent' ? t('by_agent') : t('by_model')}
               ranked
               rows={
                  split === 'agent'
                     ? data.byAgent.map((row) => ({
                          id: row.key,
                          label: row.agentName,
                          href: `/${orgId}/agents/${row.key}`,
                          bucket: row,
                       }))
                     : data.byModel.map((row) => ({ id: row.key, label: row.key, bucket: row }))
               }
            />
         </section>

         <section className="flex flex-col gap-2">
            <h3 className="font-medium">{t('dayByModel')}</h3>
            {data.byDayModel.length === 0 ? (
               <p className="text-muted-foreground">{t('empty')}</p>
            ) : (
               <div className="max-h-96 overflow-auto">
                  <table className="w-full">
                     <thead className="sticky top-0 bg-container text-left text-muted-foreground">
                        <tr>
                           <th className="py-1 pr-4 font-normal">{t('day')}</th>
                           <th className="py-1 pr-4 font-normal">{t('model')}</th>
                           <th className="py-1 pr-4 text-right font-normal">{t('tokens')}</th>
                           <th className="py-1 text-right font-normal">{t('cost')}</th>
                        </tr>
                     </thead>
                     <tbody>
                        {data.byDayModel.map((row) => (
                           <tr key={`${row.day}:${row.model}`} className="border-t">
                              <td className="py-1.5 pr-4 tabular-nums">{row.day}</td>
                              <td className="max-w-[16rem] truncate py-1.5 pr-4">{row.model}</td>
                              <td className="py-1.5 pr-4 text-right tabular-nums">
                                 {formatTokens(row.tokens)}
                              </td>
                              <td className="py-1.5 text-right tabular-nums">
                                 {formatCost(row.costMicros)}
                                 {row.unpricedEvents > 0 ? '*' : ''}
                              </td>
                           </tr>
                        ))}
                     </tbody>
                  </table>
               </div>
            )}
            {data.totals.unpricedEvents > 0 ? (
               <p className="text-muted-foreground">{t('unpricedWarning')}</p>
            ) : null}
         </section>
      </div>
   );
}
