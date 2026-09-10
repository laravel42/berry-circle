'use client';

import { useParams } from 'next/navigation';

import { getRuntimeUsage } from '@/lib/usage';
import { useSessionStore } from '@/store/session-store';

import { UsageBreakdownTable } from './usage-breakdown-table';
import { UsageDailyChart } from './usage-daily-chart';
import { UsageTiles } from './usage-tiles';
import { useUsage } from './use-usage';

/**
 * One runtime's usage by day, by agent and by hour of day (UTC). `'default'`
 * is the workspace's default runtime; a runtime detail page passes its id.
 */
export function RuntimeUsagePanel({ runtimeId, days }: { runtimeId: string; days: number }) {
   const { orgId } = useParams<{ orgId: string }>();
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? null);
   const { data, error } = useUsage(
      workspaceId ? () => getRuntimeUsage(workspaceId, runtimeId, days) : null,
      `${workspaceId}:${runtimeId}:${days}`
   );
   if (error) return <p className="text-muted-foreground">{error}</p>;
   if (!data) return <p className="text-muted-foreground">Loading usage…</p>;
   return (
      <div className="flex flex-col gap-6">
         <UsageTiles totals={data.totals} />
         <div className="grid gap-6 lg:grid-cols-2">
            <div>
               <h3 className="mb-2 font-medium">By day</h3>
               <UsageDailyChart points={data.daily} metric="cost" />
            </div>
            <div>
               <h3 className="mb-2 font-medium">By hour of day (UTC)</h3>
               <UsageDailyChart points={data.byHour} metric="tokens" />
            </div>
         </div>
         <UsageBreakdownTable
            title="By agent"
            rows={data.byAgent.map((row) => ({
               id: row.key,
               label: row.agentName,
               href: `/${orgId}/agents/${row.key}`,
               bucket: row,
            }))}
         />
      </div>
   );
}
