'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { USAGE_DAY_OPTIONS, getAgentUsage } from '@/lib/usage';
import { useSessionStore } from '@/store/session-store';

import { UsageBreakdownTable } from './usage-breakdown-table';
import { UsageDailyChart } from './usage-daily-chart';
import { UsageTiles } from './usage-tiles';
import { useUsage } from './use-usage';

/** One agent's own spend, on its page. */
export function AgentUsageTab({ agentId }: { agentId: string }) {
   const t = useTranslations('areas.usage');
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? null);
   const [days, setDays] = useState<number>(30);
   const { data, error } = useUsage(
      workspaceId ? () => getAgentUsage(workspaceId, agentId, { days }) : null,
      `${workspaceId}:${agentId}:${days}`
   );
   return (
      <div className="flex flex-col gap-6">
         <div className="flex items-center gap-1 rounded-md border p-0.5 w-fit">
            {USAGE_DAY_OPTIONS.map((option) => (
               <Button
                  key={option}
                  size="xxs"
                  variant={option === days ? 'secondary' : 'ghost'}
                  onClick={() => setDays(option)}
               >
                  {t('filters.days', { count: option })}
               </Button>
            ))}
         </div>
         {error ? <p className="text-muted-foreground">{error}</p> : null}
         {data ? (
            <>
               <UsageTiles totals={data.totals} runs={data.runs} />
               <UsageDailyChart points={data.daily} metric="cost" />
               <UsageBreakdownTable
                  title={t('leaderboard.models')}
                  rows={data.byModel.map((row) => ({ id: row.key, label: row.key, bucket: row }))}
               />
            </>
         ) : null}
      </div>
   );
}
