'use client';

import { BerryMark } from '@/components/brand/berry-mark';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useAgentsStore } from '@/store/agents-store';
import { useFilterStore } from '@/store/filter-store';
import { useIssuesStore } from '@/store/issues-store';
import { useRunsStore } from '@/store/runs-store';
import { useTranslations } from 'next-intl';
import { useMemo } from 'react';

interface WorkingRow {
   runId: string;
   agentName: string;
   agentId: string;
   issueLabel: string;
   queued: boolean;
}

/**
 * How much of the workspace is moving right now: the agents with a run in
 * flight and the tasks those runs are on.
 *
 * Hovering lists them, split into working and queued, and clicking narrows the
 * list to exactly those tasks — the question this chip raises ("which ones?")
 * answered by the list itself rather than by another panel.
 */
export function WorkingAgentsChip() {
   const t = useTranslations('issueLists');
   const runs = useRunsStore((state) => state.runs);
   const agents = useAgentsStore((state) => state.agents);
   const issues = useIssuesStore((state) => state.issues);
   const { filters, setFilters } = useFilterStore();

   const rows = useMemo<WorkingRow[]>(() => {
      const agentName = new Map(agents.map((agent) => [agent.id, agent.name]));
      const issueLabel = new Map(
         issues.map((issue) => [issue.id, `${issue.identifier} ${issue.title}`])
      );
      return runs
         .filter((run) => run.status === 'running' || run.status === 'queued')
         .map((run) => ({
            runId: run.id,
            agentId: run.agentId,
            agentName: agentName.get(run.agentId) ?? 'Agent',
            issueLabel: issueLabel.get(run.issueId) ?? run.issueId,
            queued: run.status === 'queued',
         }));
   }, [runs, agents, issues]);

   const agentIds = useMemo(() => [...new Set(rows.map((row) => row.agentId))], [rows]);
   const issueCount = useMemo(() => new Set(rows.map((row) => row.issueLabel)).size, [rows]);

   const active = useMemo(
      () =>
         filters.some(
            (filter) =>
               filter.columnId === 'assignee' &&
               filter.values.length === agentIds.length &&
               agentIds.every((id) => (filter.values as string[]).includes(id))
         ),
      [filters, agentIds]
   );

   if (rows.length === 0) return null;

   const toggle = () => {
      setFilters((previous) => {
         const withoutAssignee = previous.filter((filter) => filter.columnId !== 'assignee');
         if (active) return withoutAssignee;
         return [
            ...withoutAssignee,
            {
               columnId: 'assignee',
               type: 'option',
               operator: 'is any of',
               values: agentIds,
            },
         ];
      });
   };

   const working = rows.filter((row) => !row.queued);
   const queued = rows.filter((row) => row.queued);

   return (
      <TooltipProvider delayDuration={150}>
         <Tooltip>
            <TooltipTrigger asChild>
               <button
                  type="button"
                  onClick={toggle}
                  aria-pressed={active}
                  className={cn(
                     'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2 transition-colors',
                     active
                        ? 'border-transparent bg-accent text-foreground'
                        : 'border-border/60 text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                  )}
               >
                  <BerryMark size="sm" tone="working" pulse label="Agents at work" />
                  {t('agents.chip', { agents: agentIds.length, tasks: issueCount })}
               </button>
            </TooltipTrigger>
            <TooltipContent align="start" className="max-w-80">
               <div className="flex flex-col gap-1.5">
                  {working.length > 0 && (
                     <div>
                        <div className="font-medium">{t('agents.working')}</div>
                        {working.map((row) => (
                           <div key={row.runId} className="truncate">
                              {row.agentName} · {row.issueLabel}
                           </div>
                        ))}
                     </div>
                  )}
                  {queued.length > 0 && (
                     <div>
                        <div className="font-medium">{t('agents.queued')}</div>
                        {queued.map((row) => (
                           <div key={row.runId} className="truncate">
                              {row.agentName} · {row.issueLabel}
                           </div>
                        ))}
                     </div>
                  )}
                  <div className="text-muted-foreground">{t('agents.filter')}</div>
               </div>
            </TooltipContent>
         </Tooltip>
      </TooltipProvider>
   );
}
