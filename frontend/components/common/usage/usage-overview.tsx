'use client';

import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { getWorkspaceUsage, weeklyBuckets, type UsageQuery } from '@/lib/usage';
import { useSessionStore } from '@/store/session-store';

import { UsageBreakdownTable } from './usage-breakdown-table';
import { UsageDailyChart, type UsageMetric } from './usage-daily-chart';
import { UsageTiles } from './usage-tiles';
import { useUsage } from './use-usage';

const METRICS: UsageMetric[] = ['cost', 'tokens', 'reports'];

/**
 * The workspace's spend: what it cost, how it moved, and who spent it.
 *
 * The trend can be read as cost, tokens or reports, by day or by week, because
 * ninety days of daily bars says less than thirteen weekly ones.
 */
export default function UsageOverview({
   query,
   onState,
}: {
   query: UsageQuery;
   /** Lets the page's filter bar show when this read landed. */
   onState?: (state: { lastUpdated: Date | null; loading: boolean; reload: () => void }) => void;
}) {
   const t = useTranslations('areas.usage');
   const { orgId } = useParams<{ orgId: string }>();
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? null);
   const [metric, setMetric] = useState<UsageMetric>('cost');
   const [grain, setGrain] = useState<'daily' | 'weekly'>('daily');

   const { data, error, loading, lastUpdated, reload } = useUsage(
      workspaceId ? () => getWorkspaceUsage(workspaceId, query) : null,
      `${workspaceId}:${query.days}:${query.timezone ?? ''}:${query.boardId ?? ''}`
   );
   onState?.({ lastUpdated, loading, reload });

   if (error) return <p className="px-6 py-8 text-muted-foreground">{error}</p>;
   if (!data) return <p className="px-6 py-8 text-muted-foreground">{t('loading')}</p>;

   const points = grain === 'weekly' ? weeklyBuckets(data.daily) : data.daily;

   return (
      <div className="flex flex-col gap-8 px-6 py-6">
         <UsageTiles totals={data.totals} runs={data.runs} />

         <section className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
               <h3 className="mr-auto font-medium">{t('chart.title')}</h3>
               <div className="flex items-center gap-1 rounded-md border p-0.5">
                  {METRICS.map((option) => (
                     <Button
                        key={option}
                        size="xxs"
                        variant={metric === option ? 'secondary' : 'ghost'}
                        onClick={() => setMetric(option)}
                     >
                        {t(`chart.metric_${option}`)}
                     </Button>
                  ))}
               </div>
               <div className="flex items-center gap-1 rounded-md border p-0.5">
                  {(['daily', 'weekly'] as const).map((option) => (
                     <Button
                        key={option}
                        size="xxs"
                        variant={grain === option ? 'secondary' : 'ghost'}
                        onClick={() => setGrain(option)}
                     >
                        {t(`chart.${option}`)}
                     </Button>
                  ))}
               </div>
            </div>
            <UsageDailyChart points={points} metric={metric} />
         </section>

         <div className="grid gap-8 lg:grid-cols-2">
            <UsageBreakdownTable
               title={t('leaderboard.agents')}
               ranked
               rows={data.byAgent.map((row) => ({
                  id: row.key,
                  label: row.agentName,
                  href: `/${orgId}/agents/${row.key}`,
                  bucket: row,
               }))}
            />
            <UsageBreakdownTable
               title={t('leaderboard.models')}
               ranked
               rows={data.byModel.map((row) => ({ id: row.key, label: row.key, bucket: row }))}
            />
         </div>
      </div>
   );
}
