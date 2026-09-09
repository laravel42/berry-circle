'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import {
   Bot,
   Building2,
   CheckCircle2,
   Clock3,
   LoaderCircle,
   MessageSquare,
   Plus,
   Server,
   XCircle,
} from 'lucide-react';
import { formatDistanceToNow, parseISO, subDays } from 'date-fns';

import { BerryMark } from '@/components/brand/berry-mark';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { BerryApiError } from '@/lib/api';
import {
   agentModelDisplay,
   agentStatusDisplay,
   getWorkspaceAgent,
   pickRunnableAgent,
   type Agent,
} from '@/lib/agents';
import {
   cancelRun,
   formatRunDuration,
   runDurationMs,
   type RunRecord,
} from '@/lib/runs';
import { cn } from '@/lib/utils';
import { useAgentsStore } from '@/store/agents-store';
import { useIssuesStore } from '@/store/issues-store';
import { useRunsStore } from '@/store/runs-store';
import { useSessionStore } from '@/store/session-store';
import { toast } from 'sonner';

import { AgentConfigField } from '@/components/common/agents/agent-config-field';
import { AgentModelTab } from '@/components/common/agents/agent-model-tab';

const DETAIL_TABS = ['overview', 'work', 'model', 'settings'] as const;
type DetailTab = (typeof DETAIL_TABS)[number];

function MetaPill({
   icon: Icon,
   children,
}: {
   icon: React.ComponentType<{ className?: string }>;
   children: React.ReactNode;
}) {
   return (
      <span className="inline-flex items-center gap-1.5 rounded-md border border-border/70 px-2 py-1 text-muted-foreground">
         <Icon className="size-3.5 shrink-0" />
         {children}
      </span>
   );
}

function StatusBadge({ status }: { status: string }) {
   const display = agentStatusDisplay(status);
   return (
      <span className="inline-flex items-center gap-1.5 rounded-md border border-border/70 px-2 py-1">
         <span
            className={cn(
               'size-1.5 rounded-full',
               display.tone === 'online' && 'bg-[#00cc66]',
               display.tone === 'busy' && 'bg-amber-500',
               display.tone === 'offline' && 'bg-muted-foreground/40',
               display.tone === 'unknown' && 'bg-muted-foreground/40'
            )}
         />
         {display.label}
      </span>
   );
}

function RunStatusIcon({ status }: { status: RunRecord['status'] }) {
   if (status === 'succeeded') {
      return <CheckCircle2 className="size-4 text-[#00cc66]" aria-hidden />;
   }
   if (status === 'failed') {
      return <XCircle className="size-4 text-destructive" aria-hidden />;
   }
   if (status === 'running' || status === 'queued') {
      return <LoaderCircle className="size-4 animate-spin text-muted-foreground" aria-hidden />;
   }
   return <Clock3 className="size-4 text-muted-foreground" aria-hidden />;
}

function SummaryRow({ label, children }: { label: string; children: React.ReactNode }) {
   return (
      <div className="flex items-start justify-between gap-3 py-2">
         <span className="shrink-0 text-muted-foreground">{label}</span>
         <div className="min-w-0 text-right">{children}</div>
      </div>
   );
}

interface AgentDetailsProps {
   agentId: string;
}

export default function AgentDetails({ agentId }: AgentDetailsProps) {
   const { orgId } = useParams<{ orgId: string }>();
   const sessionUser = useSessionStore((state) => state.user);
   const storedAgents = useAgentsStore((state) => state.agents);
   const hydrateAgents = useAgentsStore((state) => state.hydrateAgents);
   const issues = useIssuesStore((state) => state.issues);
   const runs = useRunsStore((state) => state.runs);
   const upsertRun = useRunsStore((state) => state.upsertRun);

   const [agent, setAgent] = useState<Agent | null>(
      () => storedAgents.find((entry) => entry.id === agentId) ?? null
   );
   const [loadError, setLoadError] = useState<string | null>(null);
   const [activeTab, setActiveTab] = useState<DetailTab>('overview');
   const [cancellingRunId, setCancellingRunId] = useState<string | null>(null);

   useEffect(() => {
      const cached = storedAgents.find((entry) => entry.id === agentId);
      if (cached) {
         setAgent(cached);
         return;
      }
      let cancelled = false;
      void getWorkspaceAgent(agentId)
         .then((loaded) => {
            if (cancelled) return;
            setAgent(loaded);
            setLoadError(null);
            hydrateAgents(
               storedAgents.some((entry) => entry.id === loaded.id)
                  ? storedAgents.map((entry) => (entry.id === loaded.id ? loaded : entry))
                  : [...storedAgents, loaded]
            );
         })
         .catch((error: unknown) => {
            if (cancelled) return;
            setLoadError(
               error instanceof BerryApiError ? error.message : 'This agent is unavailable.'
            );
         });
      return () => {
         cancelled = true;
      };
   }, [agentId, storedAgents, hydrateAgents]);

   const agentRuns = useMemo(
      () => runs.filter((run) => run.agentId === agentId),
      [runs, agentId]
   );

   const issueById = useMemo(() => new Map(issues.map((issue) => [issue.id, issue])), [issues]);

   const activeRuns = useMemo(
      () => agentRuns.filter((run) => run.status === 'queued' || run.status === 'running'),
      [agentRuns]
   );

   const recentRuns = useMemo(
      () =>
         agentRuns
            .filter((run) => run.status !== 'queued' && run.status !== 'running')
            .slice(0, 8),
      [agentRuns]
   );

   const stats = useMemo(() => {
      const cutoff = subDays(new Date(), 30);
      const recent = agentRuns.filter((run) => parseISO(run.createdAt) >= cutoff);
      const succeeded = recent.filter((run) => run.status === 'succeeded');
      const failed = recent.filter((run) => run.status === 'failed');
      const durations = succeeded
         .map((run) => runDurationMs(run))
         .filter((value): value is number => value !== null);
      const avgMs =
         durations.length > 0
            ? durations.reduce((sum, value) => sum + value, 0) / durations.length
            : null;
      const successRate =
         recent.length > 0 ? Math.round((succeeded.length / recent.length) * 100) : null;

      const chart = Array.from({ length: 7 }, (_, index) => {
         const dayStart = subDays(new Date(), 6 - index);
         dayStart.setHours(0, 0, 0, 0);
         const dayEnd = new Date(dayStart);
         dayEnd.setHours(23, 59, 59, 999);
         const count = agentRuns.filter((run) => {
            const created = parseISO(run.createdAt);
            return created >= dayStart && created <= dayEnd;
         }).length;
         return count;
      });
      const chartMax = Math.max(...chart, 1);

      return { recent, succeeded, failed, avgMs, successRate, chart, chartMax };
   }, [agentRuns]);

   const onCancelRun = async (runId: string) => {
      setCancellingRunId(runId);
      try {
         const updated = await cancelRun(runId);
         upsertRun(updated);
         toast.success('Run cancelled');
      } catch (error) {
         toast.error(error instanceof BerryApiError ? error.message : 'Could not cancel run');
      } finally {
         setCancellingRunId(null);
      }
   };

   if (loadError) {
      return (
         <div className="px-8 py-16 text-muted-foreground">
            {loadError}{' '}
            <Link href={`/${orgId}/agents`} className="text-foreground underline-offset-2 hover:underline">
               Back to agents
            </Link>
         </div>
      );
   }

   if (!agent) {
      return <div className="px-8 py-16 text-muted-foreground">Loading agent…</div>;
   }

   const isDefault = pickRunnableAgent(storedAgents)?.id === agent.id;
   const isIdle = agent.status === 'available' && activeRuns.length === 0;
   const updatedAgo = formatDistanceToNow(parseISO(agent.updatedAt), { addSuffix: true });
   const modelLabel = agentModelDisplay(agent).label;

   return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden leading-[1.35]">
         <div className="border-b px-8 py-6">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
               <div className="flex min-w-0 gap-4">
                  <span className="flex size-14 shrink-0 items-center justify-center rounded-full bg-muted/40">
                     <BerryMark size="lg" tone="working" label={agent.name} />
                  </span>
                  <div className="min-w-0">
                     <div className="flex flex-wrap items-center gap-2">
                        <h1 className="font-medium leading-none">{agent.name}</h1>
                        <StatusBadge status={agent.status} />
                        {isIdle ? (
                           <span className="inline-flex items-center gap-1.5 rounded-md border border-border/70 px-2 py-1">
                              <span className="size-1.5 rounded-full bg-[#00cc66]" />
                              Idle
                           </span>
                        ) : null}
                     </div>
                     {agent.description ? (
                        <p className="mt-2 max-w-3xl leading-[1.35] text-muted-foreground">
                           {agent.description}
                        </p>
                     ) : null}
                     <div className="mt-3 flex flex-wrap gap-2">
                        {isDefault ? (
                           <MetaPill icon={Bot}>Default</MetaPill>
                        ) : null}
                        <MetaPill icon={Server}>Berry</MetaPill>
                        <MetaPill icon={Building2}>Workspace</MetaPill>
                        <MetaPill icon={Clock3}>Updated {updatedAgo}</MetaPill>
                     </div>
                  </div>
               </div>
               <div className="flex shrink-0 items-center gap-2">
                  <Button size="xs" variant="secondary" disabled>
                     <MessageSquare className="size-4" />
                     DM
                  </Button>
                  <Button size="xs" variant="secondary" asChild>
                     <Link href={`/${orgId}/runs?agent=${agent.id}`}>
                        <Plus className="size-4" />
                        Assign work
                     </Link>
                  </Button>
               </div>
            </div>
         </div>

         <Tabs
            value={activeTab}
            onValueChange={(value) => setActiveTab(value as DetailTab)}
            className="flex min-h-0 flex-1 flex-col"
         >
            <div className="border-b px-8">
               <TabsList className="h-10 gap-1 rounded-none bg-transparent p-0">
                  {DETAIL_TABS.map((tab) => (
                     <TabsTrigger
                        key={tab}
                        value={tab}
                        className="rounded-none border-b-2 border-transparent px-3 py-2 capitalize data-[state=active]:border-foreground data-[state=active]:bg-transparent data-[state=active]:shadow-none"
                     >
                        {tab}
                     </TabsTrigger>
                  ))}
               </TabsList>
            </div>

            <div className="min-h-0 flex-1 overflow-auto">
               <TabsContent value="overview" className="mt-0 h-full">
                  <div className="flex h-full flex-col xl:flex-row">
                     <div className="min-w-0 flex-1 px-8 py-6">
                        <section className="mb-8">
                           <h2 className="font-medium">Now</h2>
                           {activeRuns.length === 0 ? (
                              <div className="mt-3 rounded-lg border border-border/70 px-4 py-5">
                                 <p className="font-medium">No active work</p>
                                 <p className="mt-1 text-muted-foreground">
                                    This agent isn&apos;t working on anything right now.
                                 </p>
                              </div>
                           ) : (
                              <div className="mt-3 flex flex-col gap-2">
                                 {activeRuns.map((run) => {
                                    const issue = issueById.get(run.issueId);
                                    return (
                                       <div
                                          key={run.id}
                                          className="flex items-center gap-3 rounded-lg border border-border/70 px-4 py-3"
                                       >
                                          <Link
                                             href={`/${orgId}/runs?run=${run.id}`}
                                             className="flex min-w-0 flex-1 items-center gap-3 transition-colors hover:opacity-80"
                                          >
                                             <RunStatusIcon status={run.status} />
                                             <div className="min-w-0 flex-1">
                                                <p className="truncate font-medium">
                                                   {issue?.identifier ?? run.issueId.slice(0, 8)}{' '}
                                                   {issue?.title ?? 'Untitled task'}
                                                </p>
                                                <p className="capitalize text-muted-foreground">
                                                   {run.status}
                                                </p>
                                             </div>
                                          </Link>
                                          <Button
                                             size="xs"
                                             variant="ghost"
                                             className="shrink-0"
                                             disabled={cancellingRunId === run.id}
                                             onClick={() => void onCancelRun(run.id)}
                                          >
                                             {cancellingRunId === run.id ? 'Cancelling…' : 'Cancel'}
                                          </Button>
                                       </div>
                                    );
                                 })}
                              </div>
                           )}
                        </section>

                        <section>
                           <h2 className="font-medium">Recent work</h2>
                           {recentRuns.length === 0 ? (
                              <p className="mt-3 text-muted-foreground">
                                 No completed runs yet.
                              </p>
                           ) : (
                              <div className="mt-3 flex flex-col">
                                 {recentRuns.map((run) => {
                                    const issue = issueById.get(run.issueId);
                                    const duration = runDurationMs(run);
                                    const when = formatDistanceToNow(parseISO(run.createdAt), {
                                       addSuffix: true,
                                    });
                                    return (
                                       <Link
                                          key={run.id}
                                          href={`/${orgId}/runs?run=${run.id}`}
                                          className="flex items-start gap-3 border-b border-border/60 py-3 last:border-b-0 hover:bg-sidebar/30"
                                       >
                                          <RunStatusIcon status={run.status} />
                                          <div className="min-w-0 flex-1">
                                             <p className="text-muted-foreground">{when}</p>
                                             <p className="mt-0.5 truncate">
                                                <span className="font-medium">
                                                   {issue?.identifier ?? run.issueId.slice(0, 8)}
                                                </span>
                                                {issue?.title ? ` ${issue.title}` : null}
                                             </p>
                                          </div>
                                          <div className="shrink-0 text-right text-muted-foreground">
                                             <p className="capitalize">{run.status}</p>
                                             {duration !== null ? (
                                                <p>{formatRunDuration(duration)}</p>
                                             ) : null}
                                          </div>
                                       </Link>
                                    );
                                 })}
                              </div>
                           )}
                        </section>
                     </div>

                     <aside className="w-full shrink-0 border-t border-border/70 px-8 py-6 xl:w-[320px] xl:border-t-0 xl:border-l">
                        <div className="rounded-lg border border-border/70 p-4">
                           <SummaryRow label="Owner">
                              {sessionUser ? (
                                 <span className="inline-flex items-center justify-end gap-2">
                                    <Avatar className="size-5">
                                       <AvatarImage src={sessionUser.avatarUrl} alt={sessionUser.name} />
                                       <AvatarFallback>{sessionUser.name[0]?.toUpperCase() ?? '?'}</AvatarFallback>
                                    </Avatar>
                                    <span className="truncate">{sessionUser.name}</span>
                                 </span>
                              ) : (
                                 '—'
                              )}
                           </SummaryRow>
                           <SummaryRow label="Access">Workspace</SummaryRow>
                           <SummaryRow label="Runtime">Berry</SummaryRow>
                           <SummaryRow label="Model">{modelLabel}</SummaryRow>
                           <SummaryRow label="Concurrency">3</SummaryRow>
                        </div>

                        <div className="mt-4 rounded-lg border border-border/70 p-4">
                           <h3 className="font-medium">Skills</h3>
                           <p className="mt-2 text-muted-foreground">No skills assigned</p>
                        </div>

                        <div className="mt-4 rounded-lg border border-border/70 p-4">
                           <h3 className="font-medium">Last 30 days</h3>
                           <div className="mt-3 grid grid-cols-2 gap-3">
                              <div>
                                 <p className="font-medium tabular-nums">{stats.recent.length}</p>
                                 <p className="text-muted-foreground">runtimes</p>
                              </div>
                              <div>
                                 <p className="font-medium tabular-nums">
                                    {stats.successRate !== null ? `${stats.successRate}%` : '—'}
                                 </p>
                                 <p className="text-muted-foreground">succeeded</p>
                              </div>
                              <div>
                                 <p className="font-medium tabular-nums">
                                    {stats.avgMs !== null ? formatRunDuration(stats.avgMs) : '—'}
                                 </p>
                                 <p className="text-muted-foreground">avg duration</p>
                              </div>
                              <div>
                                 <p className="font-medium tabular-nums">{stats.failed.length}</p>
                                 <p className="text-muted-foreground">failed</p>
                              </div>
                           </div>
                           <div className="mt-4 flex h-16 items-end gap-1">
                              {stats.chart.map((count, index) => (
                                 <div
                                    key={index}
                                    className="flex-1 rounded-sm bg-primary/70"
                                    style={{ height: `${Math.max(8, (count / stats.chartMax) * 100)}%` }}
                                    title={`${count} runs`}
                                 />
                              ))}
                           </div>
                        </div>
                     </aside>
                  </div>
               </TabsContent>

               <TabsContent value="work" className="mt-0 px-8 py-6">
                  {agentRuns.length === 0 ? (
                     <p className="text-muted-foreground">No runs yet for this agent.</p>
                  ) : (
                     <div className="flex flex-col">
                        {agentRuns.map((run) => {
                           const issue = issueById.get(run.issueId);
                           const duration = runDurationMs(run);
                           const when = formatDistanceToNow(parseISO(run.createdAt), {
                              addSuffix: true,
                           });
                           return (
                              <Link
                                 key={run.id}
                                 href={`/${orgId}/runs?run=${run.id}`}
                                 className="flex items-start gap-3 border-b border-border/60 py-3 last:border-b-0 hover:bg-sidebar/30"
                              >
                                 <RunStatusIcon status={run.status} />
                                 <div className="min-w-0 flex-1">
                                    <p className="text-muted-foreground">{when}</p>
                                    <p className="mt-0.5 truncate">
                                       <span className="font-medium">
                                          {issue?.identifier ?? run.issueId.slice(0, 8)}
                                       </span>
                                       {issue?.title ? ` ${issue.title}` : null}
                                    </p>
                                 </div>
                                 <div className="shrink-0 text-right text-muted-foreground">
                                    <p className="capitalize">{run.status}</p>
                                    {duration !== null ? <p>{formatRunDuration(duration)}</p> : null}
                                 </div>
                              </Link>
                           );
                        })}
                     </div>
                  )}
               </TabsContent>
               <TabsContent value="model" className="mt-0 h-full">
                  <AgentModelTab
                     agentId={agent.id}
                     provider={agent.modelProvider ?? null}
                     model={agent.modelName ?? null}
                  />
               </TabsContent>
               <TabsContent value="settings" className="mt-0 flex flex-col gap-6 px-8 py-6">
                  <AgentConfigField
                     agentId={agent.id}
                     field="description"
                     value={agent.description ?? ''}
                     title="Description"
                     hint="What this agent is for."
                     placeholder="Describe what this agent does…"
                     failureNote="The runtime kept its previous description."
                  />
                  <AgentConfigField
                     agentId={agent.id}
                     field="instructions"
                     value={agent.instructions ?? ''}
                     title="Instructions"
                     hint="System prompt used for every task."
                     placeholder="Describe how this agent should approach every task…"
                     failureNote="The runtime was not updated, so the agent still uses its previous instructions."
                  />
                  <section className="flex flex-col gap-2 border-t border-border/70 pt-4">
                     <div className="flex items-baseline gap-2">
                        <h3 className="font-medium text-foreground">Capabilities</h3>
                        <p className="text-muted-foreground">
                           Tools and network access granted by the runtime.
                        </p>
                     </div>
                     {agent.capabilities.length > 0 ? (
                        <div className="flex flex-wrap gap-2">
                           {agent.capabilities.map((capability) => (
                              <span
                                 key={capability}
                                 className="rounded-md border border-border/70 px-2 py-1 text-muted-foreground"
                              >
                                 {capability}
                              </span>
                           ))}
                        </div>
                     ) : (
                        <p className="text-muted-foreground">
                           The runtime reports no capabilities for this agent.
                        </p>
                     )}
                  </section>
                  <div className="flex flex-col gap-2 border-t border-border/70 pt-4">
                     <p className="text-muted-foreground">
                        Membership and workspace-wide defaults live in workspace settings.
                     </p>
                     <Button size="xs" variant="secondary" className="w-fit" asChild>
                        <Link href={`/${orgId}/settings/ai`}>Open workspace agent settings</Link>
                     </Button>
                  </div>
               </TabsContent>
            </div>
         </Tabs>
      </div>
   );
}
