'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { Button } from '@/components/ui/button';
import { getUsageErrors, type UsageQuery } from '@/lib/usage';
import { useSessionStore } from '@/store/session-store';

import { useUsage } from './use-usage';

/** Below this, a rate says more about luck than about an agent. */
const LOW_SAMPLE = 10;

function percent(part: number, whole: number): string {
   if (whole === 0) return '0%';
   return `${Math.round((part / whole) * 100)}%`;
}

/**
 * What failed in the window, and whose it was.
 *
 * Offenders can be ranked by how many runs failed or by what share of their
 * runs failed, and a rate computed from a handful of runs is marked as such:
 * one failure out of one is not an agent that fails every time.
 */
export default function UsageErrors({
   query,
   onState,
}: {
   query: UsageQuery;
   onState?: (state: { lastUpdated: Date | null; loading: boolean; reload: () => void }) => void;
}) {
   const t = useTranslations('areas.usage.errors');
   const { orgId } = useParams<{ orgId: string }>();
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? null);
   const [rank, setRank] = useState<'count' | 'rate'>('count');

   const { data, error, loading, lastUpdated, reload } = useUsage(
      workspaceId ? () => getUsageErrors(workspaceId, query) : null,
      `errors:${workspaceId}:${query.days}:${query.timezone ?? ''}:${query.boardId ?? ''}`
   );
   onState?.({ lastUpdated, loading, reload });

   if (error) return <p className="px-6 py-8 text-muted-foreground">{error}</p>;
   if (!data) return <p className="px-6 py-8 text-muted-foreground">{t('loading')}</p>;

   const offenders = [...data.offenders].sort((left, right) =>
      rank === 'count'
         ? right.failed - left.failed
         : right.failed / Math.max(1, right.total) - left.failed / Math.max(1, left.total)
   );
   const thin = offenders.some((row) => row.total < LOW_SAMPLE);

   const tiles = [
      { label: t('failedRuns'), value: String(data.failedRuns) },
      { label: t('failureRate'), value: percent(data.failedRuns, data.totalRuns) },
      { label: t('agentsAffected'), value: String(data.agentsAffected) },
      { label: t('totalRuns'), value: String(data.totalRuns) },
   ];

   return (
      <div className="flex flex-col gap-8 px-6 py-6">
         <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {tiles.map((tile) => (
               <div key={tile.label} className="rounded-md border px-4 py-3">
                  <p className="text-muted-foreground">{tile.label}</p>
                  <p className="mt-1 font-medium tabular-nums">{tile.value}</p>
               </div>
            ))}
         </div>

         <section className="flex flex-col gap-2">
            <h3 className="font-medium">{t('chart')}</h3>
            <div className="h-48 w-full text-foreground/70">
               <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                     data={data.daily.map((row) => ({ ...row, key: row.day.slice(5) }))}
                     margin={{ top: 4, right: 4, bottom: 0, left: 4 }}
                  >
                     <XAxis
                        dataKey="key"
                        tickLine={false}
                        axisLine={false}
                        fontSize={11}
                        minTickGap={12}
                     />
                     <YAxis hide allowDecimals={false} />
                     <Tooltip cursor={{ fillOpacity: 0.08 }} />
                     <Bar dataKey="failed" fill="currentColor" radius={[2, 2, 0, 0]} />
                  </BarChart>
               </ResponsiveContainer>
            </div>
         </section>

         <div className="grid gap-8 lg:grid-cols-2">
            <section className="flex flex-col gap-2">
               <h3 className="font-medium">{t('byType')}</h3>
               {data.byType.length === 0 ? (
                  <p className="text-muted-foreground">{t('empty')}</p>
               ) : (
                  <ul className="flex flex-col gap-1.5">
                     {data.byType.map((row) => (
                        <li key={row.code} className="flex items-center justify-between gap-3">
                           <span className="truncate font-mono">{row.code}</span>
                           <span className="tabular-nums text-muted-foreground">{row.count}</span>
                        </li>
                     ))}
                  </ul>
               )}
            </section>

            <section className="flex flex-col gap-2">
               <div className="flex flex-wrap items-center gap-2">
                  <h3 className="mr-auto font-medium">{t('offenders')}</h3>
                  <div className="flex items-center gap-1 rounded-md border p-0.5">
                     {(['count', 'rate'] as const).map((option) => (
                        <Button
                           key={option}
                           size="xxs"
                           variant={rank === option ? 'secondary' : 'ghost'}
                           onClick={() => setRank(option)}
                        >
                           {t(`by_${option}`)}
                        </Button>
                     ))}
                  </div>
               </div>
               {offenders.length === 0 ? (
                  <p className="text-muted-foreground">{t('empty')}</p>
               ) : (
                  <>
                     <ul className="flex flex-col gap-1.5">
                        {offenders.map((row) => (
                           <li
                              key={row.agentId}
                              className="flex items-center justify-between gap-3"
                           >
                              <Link
                                 href={`/${orgId}/agents/${row.agentId}`}
                                 className="truncate hover:underline"
                              >
                                 {row.agentName}
                              </Link>
                              <span className="shrink-0 tabular-nums text-muted-foreground">
                                 {t('failedOf', { failed: row.failed, total: row.total })} ·{' '}
                                 {percent(row.failed, row.total)}
                                 {row.total < LOW_SAMPLE ? '*' : ''}
                              </span>
                           </li>
                        ))}
                     </ul>
                     {thin ? <p className="text-muted-foreground">{t('lowSample')}</p> : null}
                  </>
               )}
            </section>
         </div>
      </div>
   );
}
