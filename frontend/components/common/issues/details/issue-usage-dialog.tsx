'use client';

import { Button } from '@/components/ui/button';
import {
   Dialog,
   DialogContent,
   DialogDescription,
   DialogHeader,
   DialogTitle,
} from '@/components/ui/dialog';
import {
   formatCost,
   formatTokens,
   totalTokens,
   type IssueUsage,
   type UsageBucket,
} from '@/lib/usage';
import type { RunRecord } from '@/lib/runs';
import { useAgentsStore } from '@/store/agents-store';
import { useTranslations } from 'next-intl';
import { useMemo } from 'react';

/**
 * Where a task's money went.
 *
 * The sidebar shows one number, which answers "is this task expensive" and
 * nothing else. This answers the next question — *why* — and the honest answer
 * has three parts: which agent spent it, which run spent it, and how much the
 * cache saved, because a task that looks expensive and a task that would have
 * been expensive without caching are different situations.
 *
 * Per-agent totals are folded here rather than asked for: the usage endpoint
 * groups by run, and the runs already on the page say which agent each run
 * belonged to. Asking the server for the same arithmetic would be a second
 * source of truth for one number.
 */

function cacheSavedTokens(bucket: UsageBucket): number {
   // Cache reads are input tokens that were not charged at the input rate.
   // Counting them is the only cache figure the usage rows can support, and it
   // is the one a reader means by "what did the cache save me".
   return bucket.cacheReadTokens;
}

export function IssueUsageDialog({
   usage,
   runs,
   open,
   onOpenChange,
}: {
   usage: IssueUsage;
   runs: RunRecord[];
   open: boolean;
   onOpenChange: (open: boolean) => void;
}) {
   const t = useTranslations('issueDetail.usage');
   const getAgentById = useAgentsStore((state) => state.getAgentById);

   const byAgent = useMemo(() => {
      const agentOfRun = new Map(runs.map((run) => [run.id, run.agentId]));
      const totals = new Map<string, { costMicros: number; tokens: number }>();
      for (const bucket of usage.byRun) {
         const agentId = agentOfRun.get(bucket.key);
         if (!agentId) continue;
         const entry = totals.get(agentId) ?? { costMicros: 0, tokens: 0 };
         entry.costMicros += bucket.costMicros;
         entry.tokens += totalTokens(bucket);
         totals.set(agentId, entry);
      }
      return [...totals.entries()]
         .map(([agentId, entry]) => ({ agentId, ...entry }))
         .sort((left, right) => right.costMicros - left.costMicros);
   }, [usage.byRun, runs]);

   const runLabel = useMemo(() => {
      const order = new Map(
         [...runs]
            .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
            .map((run, index) => [run.id, index + 1] as const)
      );
      return (runId: string) => `#${order.get(runId) ?? '?'}`;
   }, [runs]);

   const saved = cacheSavedTokens(usage.totals);

   return (
      <Dialog open={open} onOpenChange={onOpenChange}>
         <DialogContent className="w-full sm:max-w-[620px]">
            <DialogHeader>
               <DialogTitle>{t('dialogTitle')}</DialogTitle>
               <DialogDescription>
                  {usage.totals.unpricedEvents > 0 ? t('estimated') : t('perRun')}
               </DialogDescription>
            </DialogHeader>

            <div className="flex flex-wrap gap-x-8 gap-y-2 border-b pb-3">
               <div>
                  <div className="text-muted-foreground">{t('cost')}</div>
                  <div className="tabular-nums">{formatCost(usage.totals.costMicros)}</div>
               </div>
               <div>
                  <div className="text-muted-foreground">{t('tokens')}</div>
                  <div className="tabular-nums">{formatTokens(totalTokens(usage.totals))}</div>
               </div>
               <div>
                  <div className="text-muted-foreground">{t('cacheSavings')}</div>
                  <div className="tabular-nums">{formatTokens(saved)}</div>
               </div>
               <div>
                  <div className="text-muted-foreground">{t('runs')}</div>
                  <div className="tabular-nums">{usage.byRun.length}</div>
               </div>
            </div>

            {byAgent.length > 0 ? (
               <div>
                  <h4 className="mb-1.5 text-muted-foreground">{t('perAgent')}</h4>
                  <div className="flex flex-col gap-1">
                     {byAgent.map((entry) => (
                        <div
                           key={entry.agentId}
                           className="flex items-center justify-between gap-3"
                        >
                           <span className="min-w-0 truncate">
                              {getAgentById(entry.agentId)?.name ?? t('agent')}
                           </span>
                           <span className="shrink-0 tabular-nums text-muted-foreground">
                              {formatTokens(entry.tokens)} · {formatCost(entry.costMicros)}
                           </span>
                        </div>
                     ))}
                  </div>
               </div>
            ) : null}

            <div className="min-h-0 overflow-x-auto">
               <h4 className="mb-1.5 text-muted-foreground">{t('perRun')}</h4>
               <table className="w-full text-left">
                  <thead>
                     <tr className="border-b text-muted-foreground">
                        <th scope="col" className="py-1 font-normal">
                           {t('run')}
                        </th>
                        <th scope="col" className="py-1 font-normal">
                           {t('agent')}
                        </th>
                        <th scope="col" className="py-1 text-right font-normal">
                           {t('tokens')}
                        </th>
                        <th scope="col" className="py-1 text-right font-normal">
                           {t('cost')}
                        </th>
                     </tr>
                  </thead>
                  <tbody>
                     {usage.byRun.length === 0 ? (
                        <tr>
                           <td colSpan={4} className="py-3 text-muted-foreground">
                              {t('none')}
                           </td>
                        </tr>
                     ) : (
                        usage.byRun.map((bucket) => {
                           const agentId = runs.find((run) => run.id === bucket.key)?.agentId;
                           return (
                              <tr key={bucket.key} className="border-b border-border/50">
                                 <td className="py-1.5 tabular-nums">{runLabel(bucket.key)}</td>
                                 <td className="max-w-0 truncate py-1.5">
                                    {agentId
                                       ? (getAgentById(agentId)?.name ?? t('agent'))
                                       : t('agent')}
                                 </td>
                                 <td className="py-1.5 text-right tabular-nums">
                                    {formatTokens(totalTokens(bucket))}
                                 </td>
                                 <td className="py-1.5 text-right tabular-nums">
                                    {formatCost(bucket.costMicros)}
                                 </td>
                              </tr>
                           );
                        })
                     )}
                  </tbody>
               </table>
            </div>

            <div className="flex justify-end">
               <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                  {t('close')}
               </Button>
            </div>
         </DialogContent>
      </Dialog>
   );
}

export default IssueUsageDialog;
