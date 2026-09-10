'use client';

import { Section } from '@/components/common/issues/details/panel-section';
import { formatCost, formatTokens, getIssueUsage, totalTokens } from '@/lib/usage';
import { useSessionStore } from '@/store/session-store';

import { useUsage } from './use-usage';

/** What the agents' work on this task has cost so far, across every run. */
export function IssueUsageSection({ issueId }: { issueId: string }) {
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? null);
   const { data, error } = useUsage(
      workspaceId ? () => getIssueUsage(workspaceId, issueId) : null,
      `${workspaceId}:${issueId}`
   );
   if (error || !data) return null;
   return (
      <Section title="Usage">
         {data.totals.events === 0 ? (
            <p className="text-muted-foreground">No model usage yet.</p>
         ) : (
            <div className="flex flex-col gap-1">
               <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Cost</span>
                  <span className="tabular-nums">
                     {formatCost(data.totals.costMicros)}
                     {data.totals.unpricedEvents > 0 ? '*' : ''}
                  </span>
               </div>
               <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Tokens</span>
                  <span className="tabular-nums">{formatTokens(totalTokens(data.totals))}</span>
               </div>
               <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Runs</span>
                  <span className="tabular-nums">{data.byRun.length}</span>
               </div>
            </div>
         )}
      </Section>
   );
}
