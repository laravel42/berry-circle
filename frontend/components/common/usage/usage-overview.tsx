'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { USAGE_DAY_OPTIONS, getWorkspaceUsage } from '@/lib/usage';
import { useSessionStore } from '@/store/session-store';

import { RuntimeUsagePanel } from './runtime-usage-panel';
import { UsageBreakdownTable } from './usage-breakdown-table';
import { UsageDailyChart } from './usage-daily-chart';
import { UsageTiles } from './usage-tiles';
import { useUsage } from './use-usage';

/** The workspace's model spend: totals, a daily chart, and who and what spent it. */
export default function UsageOverview() {
   const { orgId } = useParams<{ orgId: string }>();
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? null);
   const [days, setDays] = useState<number>(30);
   const { data, error, loading } = useUsage(
      workspaceId ? () => getWorkspaceUsage(workspaceId, days) : null,
      `${workspaceId}:${days}`
   );

   return (
      <div className="flex flex-col gap-8 px-6 py-6">
         <div className="flex items-center gap-1">
            {USAGE_DAY_OPTIONS.map((option) => (
               <Button
                  key={option}
                  size="sm"
                  variant={option === days ? 'secondary' : 'ghost'}
                  onClick={() => setDays(option)}
               >
                  {option} days
               </Button>
            ))}
            {loading ? <span className="ml-2 text-muted-foreground">Refreshing…</span> : null}
         </div>

         {error ? <p className="text-muted-foreground">{error}</p> : null}
         {data ? (
            <>
               <UsageTiles totals={data.totals} />
               <section>
                  <h3 className="mb-2 font-medium">Cost by day</h3>
                  <UsageDailyChart points={data.daily} metric="cost" />
               </section>
               <div className="grid gap-8 lg:grid-cols-2">
                  <UsageBreakdownTable
                     title="By agent"
                     rows={data.byAgent.map((row) => ({
                        id: row.key,
                        label: row.agentName,
                        href: `/${orgId}/agents/${row.key}`,
                        bucket: row,
                     }))}
                  />
                  <UsageBreakdownTable
                     title="By model"
                     rows={data.byModel.map((row) => ({
                        id: row.key,
                        label: row.key,
                        bucket: row,
                     }))}
                  />
               </div>
               <section className="flex flex-col gap-2">
                  <h3 className="font-medium">Default runtime</h3>
                  <RuntimeUsagePanel runtimeId="default" days={days} />
               </section>
            </>
         ) : null}
      </div>
   );
}
