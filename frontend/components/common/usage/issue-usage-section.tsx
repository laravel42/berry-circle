'use client';

import { Section } from '@/components/common/issues/details/panel-section';
import { IssueUsageDialog } from '@/components/common/issues/details/issue-usage-dialog';
import { Button } from '@/components/ui/button';
import { formatCost, formatTokens, getIssueUsage, totalTokens } from '@/lib/usage';
import { useIssueRuns } from '@/store/issue-runs-store';
import { useSessionStore } from '@/store/session-store';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { useUsage } from './use-usage';

/**
 * What the agents' work on this task has cost so far.
 *
 * Three numbers in the sidebar, and the arithmetic behind them one click away.
 * The summary stays small on purpose: cost is context for the task, not the
 * subject of the page.
 */
export function IssueUsageSection({ issueId }: { issueId: string }) {
   const t = useTranslations('issueDetail.usage');
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? null);
   const { runs } = useIssueRuns(issueId);
   const [open, setOpen] = useState(false);
   const { data, error } = useUsage(
      workspaceId ? () => getIssueUsage(workspaceId, issueId) : null,
      `${workspaceId}:${issueId}`
   );
   if (error || !data) return null;
   return (
      <Section title={t('title')}>
         {data.totals.events === 0 ? (
            <p className="text-muted-foreground">{t('none')}</p>
         ) : (
            <div className="flex flex-col gap-1">
               <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">{t('cost')}</span>
                  <span className="tabular-nums">
                     {formatCost(data.totals.costMicros)}
                     {data.totals.unpricedEvents > 0 ? '*' : ''}
                  </span>
               </div>
               <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">{t('tokens')}</span>
                  <span className="tabular-nums">{formatTokens(totalTokens(data.totals))}</span>
               </div>
               <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">{t('runs')}</span>
                  <span className="tabular-nums">{data.byRun.length}</span>
               </div>
               <Button
                  variant="ghost"
                  size="xs"
                  className="-ml-2 self-start"
                  onClick={() => setOpen(true)}
               >
                  {t('open')}
               </Button>
               <IssueUsageDialog usage={data} runs={runs} open={open} onOpenChange={setOpen} />
            </div>
         )}
      </Section>
   );
}
