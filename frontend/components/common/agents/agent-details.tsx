'use client';

import Link from 'next/link';
import { useAgentCoverage } from '@/hooks/use-agent-coverage';
import { agentHasRuntime } from '@/lib/runtimes';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Archive, MessageSquare, Plus, RotateCcw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { BerryMark } from '@/components/brand/berry-mark';
import {
   AlertDialog,
   AlertDialogAction,
   AlertDialogCancel,
   AlertDialogContent,
   AlertDialogDescription,
   AlertDialogFooter,
   AlertDialogHeader,
   AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { BerryApiError } from '@/lib/api';
import {
   agentStatusDisplay,
   archiveAgent,
   getWorkspaceAgent,
   listAgentTasks,
   loadAgentRoster,
   restoreAgent,
   useAgentAvatarSrc,
   type Agent,
   type AgentRoster,
   type AgentTask,
} from '@/lib/agents';
import { cn } from '@/lib/utils';
import { useAgentsStore } from '@/store/agents-store';
import AgentActivityTab from './agent-activity-tab';
import AgentAssignWorkDialog from './agent-assign-work-dialog';
import AgentCapabilitiesTab from './agent-capabilities-tab';
import AgentOverviewTab from './agent-overview-tab';
import AgentSettingsTab from './agent-settings-tab';
import AgentWorkTab from './agent-work-tab';

const TABS = ['overview', 'activity', 'work', 'capabilities', 'settings'] as const;
type DetailTab = (typeof TABS)[number];

const isTab = (value: string | null): value is DetailTab =>
   value !== null && (TABS as readonly string[]).includes(value);

/**
 * One agent, in five views.
 *
 * The open tab lives in the URL rather than in state, so a tab can be linked,
 * reopened and navigated back to — and so "needs a runtime" can point at the
 * settings tab instead of describing where to find it.
 */
export default function AgentDetails({ agentId }: { agentId: string }) {
   const { orgId } = useParams<{ orgId: string }>();
   const router = useRouter();
   const pathname = usePathname();
   const searchParams = useSearchParams();
   const t = useTranslations('agentsChat.detail');
   const coverage = useAgentCoverage();
   const listCopy = useTranslations('agentsChat.list');

   const storedAgent = useAgentsStore((state) => state.getAgentById(agentId));
   const upsertAgent = useAgentsStore((state) => state.upsertAgent);
   const removeAgent = useAgentsStore((state) => state.removeAgent);

   const [agent, setAgent] = useState<Agent | null>(storedAgent ?? null);
   const [status, setStatus] = useState<'loading' | 'ready' | 'missing' | 'forbidden'>(
      storedAgent ? 'ready' : 'loading'
   );
   const [roster, setRoster] = useState<AgentRoster | undefined>(undefined);
   const [tasks, setTasks] = useState<AgentTask[] | null>(null);
   const [cursor, setCursor] = useState<string | null>(null);
   const [loadingMore, setLoadingMore] = useState(false);
   const [readOnly, setReadOnly] = useState(false);
   const [dirty, setDirty] = useState(false);
   const [pendingTab, setPendingTab] = useState<DetailTab | null>(null);
   const [assigning, setAssigning] = useState(false);

   const view: DetailTab = isTab(searchParams?.get('view') ?? null)
      ? (searchParams?.get('view') as DetailTab)
      : 'overview';

   const avatarSrc = useAgentAvatarSrc(agent?.avatarUrl);

   const loadAgent = useCallback(async () => {
      try {
         const loaded = await getWorkspaceAgent(agentId);
         setAgent(loaded);
         upsertAgent(loaded);
         setStatus('ready');
      } catch (error) {
         if (error instanceof BerryApiError && error.status === 403) {
            setStatus('forbidden');
            return;
         }
         setStatus('missing');
      }
   }, [agentId, upsertAgent]);

   const loadRoster = useCallback(async () => {
      // Thirty days, because the overview's stat tiles are a month; the
      // sparkline takes the last seven points of the same series.
      const entries = await loadAgentRoster(30).catch(() => null);
      if (entries) setRoster(entries.get(agentId));
   }, [agentId]);

   const loadTasks = useCallback(async () => {
      try {
         const page = await listAgentTasks(agentId);
         setTasks(page.nodes);
         setCursor(page.pageInfo.hasNextPage ? (page.pageInfo.endCursor ?? null) : null);
      } catch {
         setTasks([]);
         setCursor(null);
      }
   }, [agentId]);

   useEffect(() => {
      void loadAgent();
      void loadRoster();
      void loadTasks();
   }, [loadAgent, loadRoster, loadTasks]);

   // A half-written instruction is the one thing on this page that a stray
   // click can destroy, so the browser is asked to confirm as well.
   useEffect(() => {
      if (!dirty) return;
      const warn = (event: BeforeUnloadEvent) => event.preventDefault();
      window.addEventListener('beforeunload', warn);
      return () => window.removeEventListener('beforeunload', warn);
   }, [dirty]);

   const openTab = useCallback(
      (next: DetailTab) => {
         const params = new URLSearchParams(searchParams?.toString() ?? '');
         params.set('view', next);
         router.replace(`${pathname}?${params.toString()}`, { scroll: false });
      },
      [pathname, router, searchParams]
   );

   const requestTab = (next: DetailTab) => {
      if (dirty && next !== view) {
         setPendingTab(next);
         return;
      }
      openTab(next);
   };

   const onChanged = (next: Agent) => {
      setAgent(next);
      upsertAgent(next);
   };

   const loadMore = async () => {
      if (!cursor) return;
      setLoadingMore(true);
      try {
         const page = await listAgentTasks(agentId, cursor);
         setTasks((current) => [...(current ?? []), ...page.nodes]);
         setCursor(page.pageInfo.hasNextPage ? (page.pageInfo.endCursor ?? null) : null);
      } finally {
         setLoadingMore(false);
      }
   };

   if (status === 'loading') {
      return (
         <div className="flex flex-col gap-4 px-8 py-8">
            <Skeleton className="h-14 w-14 rounded-full" />
            <Skeleton className="h-5 w-56" />
            <Skeleton className="h-4 w-full max-w-xl" />
            <Skeleton className="h-40 w-full max-w-3xl" />
         </div>
      );
   }

   if (status !== 'ready' || !agent) {
      return (
         <div className="flex flex-col items-start gap-3 px-8 py-16">
            <p className="text-muted-foreground">
               {status === 'forbidden' ? t('forbidden') : t('notFound')}
            </p>
            <Link href={`/${orgId}/agents`} className="underline-offset-2 hover:underline">
               {t('notFoundBack')}
            </Link>
         </div>
      );
   }

   const presence = agentStatusDisplay(agent.status);
   const archived = Boolean(agent.archivedAt);
   const isProtected = agent.capabilities.includes('orchestrate');
   const needsRuntime = roster !== undefined && !agentHasRuntime(coverage, agentId) && !archived;

   const tabLabel: Record<DetailTab, string> = {
      overview: t('tabOverview'),
      activity: t('tabActivity'),
      work: t('tabWork'),
      capabilities: t('tabCapabilities'),
      settings: t('tabSettings'),
   };

   return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
         <div className="border-b px-8 py-6">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
               <div className="flex min-w-0 gap-4">
                  <span className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted/40">
                     {avatarSrc ? (
                        // eslint-disable-next-line @next/next/no-img-element -- a blob or external URL, not an optimisable asset
                        <img src={avatarSrc} alt="" className="size-full object-cover" />
                     ) : (
                        <BerryMark size="lg" tone="working" label={agent.name} />
                     )}
                  </span>
                  <div className="min-w-0">
                     <div className="flex flex-wrap items-center gap-2">
                        <h1 className="font-medium leading-none">{agent.name}</h1>
                        <span className="inline-flex items-center gap-1.5 rounded-md border border-border/70 px-2 py-1 text-muted-foreground">
                           <span
                              className={cn(
                                 'size-1.5 rounded-full',
                                 presence.tone === 'online' && 'bg-[#00cc66]',
                                 presence.tone === 'busy' && 'bg-amber-500',
                                 (presence.tone === 'offline' || presence.tone === 'unknown') &&
                                    'bg-muted-foreground/40'
                              )}
                           />
                           {presence.tone === 'online'
                              ? listCopy('availabilityAvailable')
                              : presence.tone === 'busy'
                                ? listCopy('availabilityBusy')
                                : presence.tone === 'offline'
                                  ? listCopy('availabilityOffline')
                                  : listCopy('availabilityUnknown')}
                        </span>
                     </div>
                     {agent.description ? (
                        <p className="mt-2 max-w-3xl text-muted-foreground">{agent.description}</p>
                     ) : null}
                  </div>
               </div>

               <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <Button size="xs" variant="secondary" asChild>
                     <Link href={`/${orgId}/chat?agent=${agent.id}`}>
                        <MessageSquare className="size-4" />
                        {t('chat')}
                     </Link>
                  </Button>
                  <Button
                     size="xs"
                     variant="secondary"
                     disabled={archived}
                     onClick={() => setAssigning(true)}
                  >
                     <Plus className="size-4" />
                     {t('assignWork')}
                  </Button>
                  {archived ? (
                     <Button
                        size="xs"
                        variant="secondary"
                        onClick={() =>
                           void restoreAgent(agent.id).then(
                              (next) => {
                                 onChanged(next);
                                 toast.success(listCopy('restoreDone', { name: agent.name }));
                              },
                              (error: unknown) =>
                                 toast.error(
                                    error instanceof BerryApiError
                                       ? error.message
                                       : t('failureUnknown')
                                 )
                           )
                        }
                     >
                        <RotateCcw className="size-4" />
                        {t('restore')}
                     </Button>
                  ) : (
                     <Button
                        size="xs"
                        variant="secondary"
                        disabled={isProtected}
                        title={isProtected ? listCopy('protectedAgent') : undefined}
                        onClick={() => {
                           if (!window.confirm(listCopy('archiveTitle', { name: agent.name }))) {
                              return;
                           }
                           void archiveAgent(agent.id).then(
                              () => {
                                 removeAgent(agent.id);
                                 toast.success(listCopy('archiveDone', { name: agent.name }));
                                 router.push(`/${orgId}/agents`);
                              },
                              (error: unknown) =>
                                 toast.error(
                                    error instanceof BerryApiError
                                       ? error.message
                                       : t('failureUnknown')
                                 )
                           );
                        }}
                     >
                        <Archive className="size-4" />
                        {t('archive')}
                     </Button>
                  )}
               </div>
            </div>

            <div className="mt-4 flex flex-col gap-2">
               {readOnly ? (
                  <p className="rounded-md border border-border/70 px-3 py-2 text-muted-foreground">
                     {t('bannerReadOnly')}
                  </p>
               ) : null}
               {archived ? (
                  <p className="flex flex-wrap items-center gap-2 rounded-md border border-border/70 bg-muted/30 px-3 py-2">
                     {t('bannerArchived')}
                  </p>
               ) : null}
               {needsRuntime ? (
                  <p className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2">
                     {t('bannerNoRuntime')}
                     <button
                        type="button"
                        onClick={() => requestTab('settings')}
                        className="underline underline-offset-2"
                     >
                        {t('bannerNoRuntimeLink')}
                     </button>
                  </p>
               ) : null}
            </div>
         </div>

         <Tabs
            value={view}
            onValueChange={(value) => requestTab(value as DetailTab)}
            className="flex min-h-0 flex-1 flex-col"
         >
            <div className="border-b px-8">
               <TabsList className="h-10 gap-1 rounded-none bg-transparent p-0">
                  {TABS.map((tab) => (
                     <TabsTrigger
                        key={tab}
                        value={tab}
                        className="rounded-none border-b-2 border-transparent px-3 py-2 data-[state=active]:border-foreground data-[state=active]:bg-transparent data-[state=active]:shadow-none"
                     >
                        {tabLabel[tab]}
                     </TabsTrigger>
                  ))}
               </TabsList>
            </div>

            {/* Rendered outside TabsContent so a tab's own state is dropped
                when it closes: a half-loaded task page that comes back on
                return would be showing a moment that has since passed. */}
            <div className="min-h-0 flex-1 overflow-auto">
               {view === 'overview' ? (
                  <AgentOverviewTab
                     agent={agent}
                     roster={roster}
                     tasks={tasks}
                     onOpenSettings={() => requestTab('settings')}
                  />
               ) : null}
               {view === 'activity' ? (
                  <AgentActivityTab
                     agentName={agent.name}
                     tasks={tasks}
                     cursor={cursor}
                     loadingMore={loadingMore}
                     onLoadMore={() => void loadMore()}
                     onChanged={() => {
                        void loadTasks();
                        void loadRoster();
                     }}
                  />
               ) : null}
               {view === 'work' ? <AgentWorkTab agentId={agent.id} /> : null}
               {view === 'capabilities' ? (
                  <AgentCapabilitiesTab
                     agent={agent}
                     readOnly={readOnly || archived}
                     onChange={onChanged}
                     onDirtyChange={setDirty}
                     onForbidden={() => setReadOnly(true)}
                  />
               ) : null}
               {view === 'settings' ? (
                  <AgentSettingsTab
                     agent={agent}
                     roster={roster}
                     readOnly={readOnly || archived}
                     onChange={onChanged}
                     onRosterStale={() => void loadRoster()}
                     onForbidden={() => setReadOnly(true)}
                  />
               ) : null}
            </div>
         </Tabs>

         <AgentAssignWorkDialog agent={agent} open={assigning} onOpenChange={setAssigning} />

         <AlertDialog
            open={pendingTab !== null}
            onOpenChange={(open) => (open ? null : setPendingTab(null))}
         >
            <AlertDialogContent>
               <AlertDialogHeader>
                  <AlertDialogTitle>{t('unsavedTitle')}</AlertDialogTitle>
                  <AlertDialogDescription>{t('unsavedBody')}</AlertDialogDescription>
               </AlertDialogHeader>
               <AlertDialogFooter>
                  <AlertDialogCancel>{t('unsavedStay')}</AlertDialogCancel>
                  <AlertDialogAction
                     onClick={() => {
                        const next = pendingTab;
                        setPendingTab(null);
                        setDirty(false);
                        if (next) openTab(next);
                     }}
                  >
                     {t('unsavedLeave')}
                  </AlertDialogAction>
               </AlertDialogFooter>
            </AlertDialogContent>
         </AlertDialog>
      </div>
   );
}
