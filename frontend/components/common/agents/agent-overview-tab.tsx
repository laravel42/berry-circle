'use client';

import { AlertTriangle } from 'lucide-react';
import { useAgentCoverage } from '@/hooks/use-agent-coverage';
import { agentHasRuntime } from '@/lib/runtimes';
import { useTranslations } from 'next-intl';

import { AgentSparkline } from '@/components/common/agents/agent-sparkline';
import { Button } from '@/components/ui/button';
import {
   agentModelDisplay,
   agentTaskDurationMs,
   type Agent,
   type AgentRoster,
   type AgentTask,
} from '@/lib/agents';
import { formatRunDuration } from '@/lib/runs';
import { cn } from '@/lib/utils';

interface AgentOverviewTabProps {
   agent: Agent;
   /** Owner, runtime, load and a 30-day history; absent while it loads. */
   roster: AgentRoster | undefined;
   /** The newest page of this agent's tasks, for durations. */
   tasks: AgentTask[] | null;
   onOpenSettings: () => void;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
   return (
      <div className="flex items-start justify-between gap-3 py-2">
         <span className="shrink-0 text-muted-foreground">{label}</span>
         <div className="min-w-0 text-right">{children}</div>
      </div>
   );
}

function Stat({ value, label }: { value: string; label: string }) {
   return (
      <div>
         <p className="font-medium tabular-nums">{value}</p>
         <p className="text-muted-foreground">{label}</p>
      </div>
   );
}

/**
 * What this agent is, and how it has been doing.
 *
 * Counts come from the roster, which aggregates every run the agent has;
 * durations come from the page of tasks already loaded, because how long work
 * takes is not something a daily count can answer. Where the two disagree in
 * scope the label says which one it is.
 */
export default function AgentOverviewTab({
   agent,
   roster,
   tasks,
   onOpenSettings,
}: AgentOverviewTabProps) {
   const t = useTranslations('agentsChat.detail');
   const coverage = useAgentCoverage();
   const list = useTranslations('agentsChat.list');
   const common = useTranslations('agentsChat.common');

   const runs = roster?.activity.reduce((sum, point) => sum + point.runs, 0) ?? 0;
   const failed = roster?.activity.reduce((sum, point) => sum + point.failed, 0) ?? 0;
   const succeeded = runs === 0 ? null : Math.round(((runs - failed) / runs) * 100);

   const durations = (tasks ?? [])
      .filter((task) => task.status === 'succeeded')
      .map(agentTaskDurationMs)
      .filter((value): value is number => value !== null);
   const average =
      durations.length === 0
         ? null
         : durations.reduce((sum, value) => sum + value, 0) / durations.length;

   const runtimeHealth =
      roster?.runtimeStatus === 'active'
         ? list('runtimeHealthy')
         : roster?.runtimeStatus === 'unreachable'
           ? list('runtimeUnreachable')
           : roster?.runtimeStatus === 'disabled'
             ? list('runtimeDisabled')
             : null;

   // Work is waiting and nothing can pick it up. Said here rather than left to
   // the runtime cell, because a queue that cannot drain is the one fact on
   // this page somebody has to act on.
   // Only a bound runtime's status is known here; an agent on the workspace
   // default is stalled only when there is no runtime for it at all.
   const stalled =
      (roster?.queued ?? 0) > 0 &&
      (!agentHasRuntime(coverage, agent.id) ||
         (roster?.runtimeId !== null && roster?.runtimeStatus !== 'active'));

   const accessLabel =
      agent.access?.assign === 'admins'
         ? list('accessAdmins')
         : agent.access?.assign === 'listed'
           ? list('accessListed')
           : list('accessEveryone');

   return (
      <div className="flex h-full flex-col gap-6 px-8 py-6 xl:flex-row">
         <div className="min-w-0 flex-1">
            {stalled ? (
               <div className="mb-6 flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-3">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" aria-hidden />
                  <div className="min-w-0">
                     <p>{t('queuedNoRuntime', { count: roster?.queued ?? 0 })}</p>
                     <Button
                        size="xs"
                        variant="secondary"
                        className="mt-2"
                        onClick={onOpenSettings}
                     >
                        {t('bannerNoRuntimeLink')}
                     </Button>
                  </div>
               </div>
            ) : null}

            <section className="rounded-lg border border-border/70 p-4">
               <h2 className="font-medium">{t('overviewStats')}</h2>
               <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Stat value={String(runs)} label={t('statRuns')} />
                  <Stat
                     value={succeeded === null ? common('none') : `${succeeded}%`}
                     label={t('statSucceeded')}
                  />
                  <Stat
                     value={average === null ? common('none') : formatRunDuration(average)}
                     label={t('statAvg')}
                  />
                  <Stat value={String(failed)} label={t('statFailed')} />
               </div>
               {roster ? (
                  <div className="mt-4">
                     <AgentSparkline
                        activity={roster.activity.slice(-7)}
                        emptyLabel={list('sparkEmpty')}
                        describe={(point) =>
                           list('sparkTooltip', {
                              day: point.day,
                              runs: point.runs,
                              failed: point.failed,
                              percent: point.percent,
                           })
                        }
                     />
                  </div>
               ) : null}
            </section>
         </div>

         <aside className="w-full shrink-0 xl:w-80">
            <div className="rounded-lg border border-border/70 p-4">
               <Row label={t('overviewOwner')}>{roster?.ownerName ?? list('ownerWorkspace')}</Row>
               <Row label={t('overviewAccess')}>{accessLabel}</Row>
               <Row label={t('overviewRuntime')}>
                  {roster?.runtimeId ? (
                     <span className="inline-flex items-center gap-1.5">
                        <span
                           className={cn(
                              'size-1.5 rounded-full',
                              roster.runtimeStatus === 'active' ? 'bg-[#00cc66]' : 'bg-amber-500'
                           )}
                        />
                        <span className="truncate">{roster.runtimeName}</span>
                        {runtimeHealth ? (
                           <span className="text-muted-foreground">{runtimeHealth}</span>
                        ) : null}
                     </span>
                  ) : (
                     <button
                        type="button"
                        onClick={onOpenSettings}
                        className="text-amber-500 underline-offset-2 hover:underline"
                     >
                        {list('runtimeNone')}
                     </button>
                  )}
               </Row>
               <Row label={t('overviewModel')}>{agentModelDisplay(agent).label}</Row>
               <Row label={t('overviewConcurrency')}>{agent.maxConcurrency ?? common('none')}</Row>
            </div>

            <div className="mt-4 rounded-lg border border-border/70 p-4">
               <h3 className="font-medium">{t('overviewSkills')}</h3>
               {agent.capabilities.length === 0 ? (
                  <p className="mt-2 text-muted-foreground">{t('overviewNoSkills')}</p>
               ) : (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                     {agent.capabilities.map((skill) => (
                        <span
                           key={skill}
                           className="rounded-md border border-border/70 px-2 py-0.5 text-muted-foreground"
                        >
                           {skill}
                        </span>
                     ))}
                  </div>
               )}
            </div>
         </aside>
      </div>
   );
}
