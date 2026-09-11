'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

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
import { Checkbox } from '@/components/ui/checkbox';
import {
   Dialog,
   DialogContent,
   DialogDescription,
   DialogHeader,
   DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { BerryApiError } from '@/lib/api';
import {
   archiveAgent,
   cancelAgentTasks,
   getAgentAccess,
   loadAgentRoster,
   loadArchivedAgents,
   loadWorkspaceAgents,
   modelPairKey,
   restoreAgent,
   setAgentAccess,
   type Agent,
} from '@/lib/agents';
import { cn } from '@/lib/utils';
import {
   useAgentsListStore,
   type AgentColumn,
   type AgentsSortKey,
} from '@/store/agents-list-store';
import { useAgentsStore } from '@/store/agents-store';
import { useSessionStore } from '@/store/session-store';
import AgentLine, { COLUMN_BREAKPOINT, COLUMN_WIDTH } from './agent-line';

/** Which column heading sorts by what; the rest are labels only. */
const SORT_FOR_COLUMN: Partial<Record<AgentColumn, AgentsSortKey>> = {
   runs: 'runs',
   lastActive: 'activity',
};

interface Confirm {
   kind: 'cancel-runs' | 'archive';
   agent: Agent;
   running: number;
   queued: number;
}

interface BulkReport {
   done: number;
   total: number;
   failures: string[];
}

const reason = (error: unknown, fallback: string) =>
   error instanceof BerryApiError ? error.message : fallback;

/**
 * The agents table.
 *
 * Three lists are in play and only one is on screen: the live roster (held in
 * the agents store, shared with every other agent surface), the archive (read
 * on demand) and the per-agent facts the rows draw. Scope, search, filters and
 * sort are the toolbar's, read from the list store.
 */
export default function Agents() {
   const t = useTranslations('agentsChat.list');
   const common = useTranslations('agentsChat.common');
   const { orgId } = useParams<{ orgId: string }>();
   const router = useRouter();

   const sessionUserId = useSessionStore((state) => state.user?.id);
   const agents = useAgentsStore((state) => state.agents);
   const archived = useAgentsStore((state) => state.archived);
   const roster = useAgentsStore((state) => state.roster);
   const storedError = useAgentsStore((state) => state.error);
   const hydrateAgents = useAgentsStore((state) => state.hydrateAgents);
   const hydrateArchived = useAgentsStore((state) => state.hydrateArchived);
   const hydrateRoster = useAgentsStore((state) => state.hydrateRoster);
   const upsertAgent = useAgentsStore((state) => state.upsertAgent);
   const removeAgent = useAgentsStore((state) => state.removeAgent);

   const { scope, search, sortKey, sortDescending, filters, columns, selected } =
      useAgentsListStore();
   const sortBy = useAgentsListStore((state) => state.sortBy);
   const toggleSelected = useAgentsListStore((state) => state.toggleSelected);
   const setSelected = useAgentsListStore((state) => state.setSelected);
   const clearSelection = useAgentsListStore((state) => state.clearSelection);

   const [loading, setLoading] = useState(true);
   const [confirm, setConfirm] = useState<Confirm | null>(null);
   const [bulkAccessOpen, setBulkAccessOpen] = useState(false);
   const [bulkReport, setBulkReport] = useState<BulkReport | null>(null);
   const [busy, setBusy] = useState(false);

   const load = useCallback(async () => {
      setLoading(true);
      try {
         const [live, entries] = await Promise.all([
            loadWorkspaceAgents(),
            // Best effort: an agent list without its roster still lists agents,
            // and the cells that need the roster simply stay empty.
            loadAgentRoster(7).catch(() => new Map()),
         ]);
         hydrateAgents(live, null);
         hydrateRoster(entries);
      } catch (error) {
         hydrateAgents([], reason(error, t('errorTitle')));
      } finally {
         setLoading(false);
      }
   }, [hydrateAgents, hydrateRoster, t]);

   useEffect(() => {
      void load();
   }, [load]);

   // The archive is read the first time it is asked for, and re-read whenever
   // something in it changes.
   const loadArchive = useCallback(async () => {
      try {
         hydrateArchived(await loadArchivedAgents());
      } catch (error) {
         toast.error(reason(error, t('errorTitle')));
      }
   }, [hydrateArchived, t]);

   useEffect(() => {
      if (scope !== 'archived' || archived !== null) return;
      void loadArchive();
   }, [scope, archived, loadArchive]);

   const rows = useMemo(() => {
      const source =
         scope === 'archived'
            ? (archived ?? [])
            : scope === 'mine'
              ? agents.filter((agent) => roster.get(agent.id)?.ownerId === sessionUserId)
              : agents;

      const query = search.trim().toLowerCase();
      const matched = source.filter((agent) => {
         if (
            query &&
            !agent.name.toLowerCase().includes(query) &&
            !(agent.description ?? '').toLowerCase().includes(query)
         ) {
            return false;
         }
         const entry = roster.get(agent.id);
         if (filters.availability && agent.status !== filters.availability) return false;
         if (filters.access && (agent.access?.assign ?? 'everyone') !== filters.access) return false;
         if (filters.runtime) {
            const runtimeId = entry?.runtimeId ?? 'none';
            if (runtimeId !== filters.runtime) return false;
         }
         if (filters.owner) {
            const ownerId = entry?.ownerId ?? 'workspace';
            if (ownerId !== filters.owner) return false;
         }
         if (filters.model && modelPairKey(agent) !== filters.model) return false;
         return true;
      });

      const direction = sortDescending ? -1 : 1;
      return matched.slice().sort((left, right) => {
         if (sortKey === 'name') return direction * left.name.localeCompare(right.name);
         if (sortKey === 'created') return direction * left.createdAt.localeCompare(right.createdAt);
         if (sortKey === 'runs') {
            return direction * ((roster.get(left.id)?.totalRuns ?? 0) - (roster.get(right.id)?.totalRuns ?? 0));
         }
         // Recent activity, falling back to when the row last changed so an
         // agent that has never run still lands somewhere deterministic.
         const leftAt = roster.get(left.id)?.lastActiveAt ?? left.updatedAt;
         const rightAt = roster.get(right.id)?.lastActiveAt ?? right.updatedAt;
         return direction * leftAt.localeCompare(rightAt);
      });
   }, [scope, archived, agents, roster, sessionUserId, search, filters, sortKey, sortDescending]);

   const selectedRows = rows.filter((agent) => selected.includes(agent.id));
   const allSelected = rows.length > 0 && selectedRows.length === rows.length;

   const runConfirm = async () => {
      if (!confirm) return;
      setBusy(true);
      try {
         if (confirm.kind === 'cancel-runs') {
            const cancelled = await cancelAgentTasks(confirm.agent.id);
            toast.success(t('cancelRunsDone', { count: cancelled }));
            hydrateRoster(await loadAgentRoster(7).catch(() => roster));
         } else {
            await archiveAgent(confirm.agent.id);
            removeAgent(confirm.agent.id);
            hydrateArchived(null);
            toast.success(t('archiveDone', { name: confirm.agent.name }));
         }
         setConfirm(null);
      } catch (error) {
         toast.error(reason(error, t('errorTitle')));
      } finally {
         setBusy(false);
      }
   };

   const restore = async (agent: Agent) => {
      try {
         const restored = await restoreAgent(agent.id);
         upsertAgent(restored);
         hydrateArchived(null);
         await load();
         toast.success(t('restoreDone', { name: agent.name }));
      } catch (error) {
         toast.error(reason(error, t('errorTitle')));
      }
   };

   /** Applies one change across the selection and reports what did not take. */
   const bulk = async (label: string, apply: (agent: Agent) => Promise<void>) => {
      setBusy(true);
      const failures: string[] = [];
      let done = 0;
      for (const agent of selectedRows) {
         try {
            await apply(agent);
            done += 1;
         } catch (error) {
            failures.push(`${agent.name}: ${reason(error, label)}`);
         }
      }
      setBulkReport({ done, total: selectedRows.length, failures });
      setBusy(false);
      clearSelection();
      hydrateArchived(null);
      await load();
   };

   const header = (column: AgentColumn, label: string, align?: string) => {
      if (!columns.includes(column)) return null;
      const key = SORT_FOR_COLUMN[column];
      const classes = cn(
         'shrink-0 items-center gap-1',
         COLUMN_WIDTH[column],
         COLUMN_BREAKPOINT[column] ?? 'flex',
         align
      );
      if (!key) {
         return <div className={classes}>{label}</div>;
      }
      return (
         <div className={classes}>
            <button
               type="button"
               onClick={() => sortBy(key)}
               aria-label={label}
               className={cn(
                  'truncate hover:text-foreground',
                  sortKey === key && 'text-foreground'
               )}
            >
               {label}
               {sortKey === key ? <span aria-hidden>{sortDescending ? ' ↓' : ' ↑'}</span> : null}
            </button>
         </div>
      );
   };

   return (
      <div className="w-full">
         <div className="sticky top-0 z-10 flex items-center gap-3 border-b bg-container px-6 py-1.5 text-muted-foreground">
            <Checkbox
               checked={allSelected}
               onCheckedChange={() =>
                  setSelected(allSelected ? [] : rows.map((agent) => agent.id))
               }
               aria-label={t('selectAll')}
               className="shrink-0"
            />
            <button
               type="button"
               onClick={() => sortBy('name')}
               className={cn(
                  'min-w-0 flex-1 text-left hover:text-foreground',
                  sortKey === 'name' && 'text-foreground'
               )}
            >
               {t('colAgent')}
               {sortKey === 'name' ? <span aria-hidden>{sortDescending ? ' ↓' : ' ↑'}</span> : null}
            </button>
            {header('presence', t('colPresence'))}
            {header('workload', t('colWorkload'))}
            {header('runtime', t('colRuntime'))}
            {header('activity', t('colActivity'))}
            {header('runs', t('colRuns'), 'justify-end')}
            {header('lastActive', t('colLastActive'))}
            {header('model', t('colModel'))}
            {header('owner', t('colOwner'))}
            {header('access', t('colAccess'))}
            <span className="size-6 shrink-0" aria-hidden />
         </div>

         {selectedRows.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2 border-b bg-sidebar/40 px-6 py-2">
               <span className="mr-2">{t('bulkSelected', { count: selectedRows.length })}</span>
               {scope === 'archived' ? (
                  <Button
                     size="xs"
                     variant="secondary"
                     disabled={busy}
                     onClick={() =>
                        void bulk(t('errorTitle'), async (agent) => {
                           await restoreAgent(agent.id);
                        })
                     }
                  >
                     {t('bulkRestore')}
                  </Button>
               ) : (
                  <>
                     <Button
                        size="xs"
                        variant="secondary"
                        disabled={busy}
                        onClick={() => setBulkAccessOpen(true)}
                     >
                        {t('bulkAccess')}
                     </Button>
                     <Button
                        size="xs"
                        variant="secondary"
                        disabled={busy}
                        onClick={() =>
                           void bulk(t('errorTitle'), async (agent) => {
                              await archiveAgent(agent.id);
                           })
                        }
                     >
                        {t('bulkArchive')}
                     </Button>
                  </>
               )}
               <Button size="xs" variant="ghost" onClick={() => clearSelection()}>
                  {t('bulkClear')}
               </Button>
            </div>
         ) : null}

         {bulkReport ? (
            <div className="border-b bg-sidebar/20 px-6 py-2" role="status">
               <div className="flex items-center gap-3">
                  <span>{t('bulkDone', { done: bulkReport.done, total: bulkReport.total })}</span>
                  <Button size="xs" variant="ghost" onClick={() => setBulkReport(null)}>
                     {common('close')}
                  </Button>
               </div>
               {bulkReport.failures.length > 0 ? (
                  <ul className="mt-1 text-muted-foreground">
                     <li>{t('bulkFailed', { count: bulkReport.failures.length })}</li>
                     {bulkReport.failures.map((failure) => (
                        <li key={failure}>{failure}</li>
                     ))}
                  </ul>
               ) : null}
            </div>
         ) : null}

         {loading ? (
            <div className="flex flex-col gap-px p-6">
               {[0, 1, 2, 3, 4].map((row) => (
                  <div key={row} className="flex items-center gap-3 py-2">
                     <Skeleton className="size-8 rounded-md" />
                     <Skeleton className="h-4 w-48" />
                     <Skeleton className="ml-auto h-4 w-24" />
                     <Skeleton className="hidden h-4 w-20 md:block" />
                  </div>
               ))}
            </div>
         ) : storedError ? (
            <div className="flex flex-col items-start gap-3 px-6 py-10">
               <p className="text-muted-foreground">{storedError}</p>
               <Button size="xs" variant="secondary" onClick={() => void load()}>
                  {common('retry')}
               </Button>
            </div>
         ) : rows.length === 0 ? (
            <div className="px-6 py-10 text-muted-foreground">
               {search.trim() || Object.values(filters).some(Boolean) ? (
                  t('noMatch')
               ) : scope === 'archived' ? (
                  t('emptyArchived')
               ) : (
                  <>
                     <p>{t('empty')}</p>
                     <p className="mt-1">{t('emptyHint')}</p>
                  </>
               )}
            </div>
         ) : (
            rows.map((agent) => (
               <AgentLine
                  key={agent.id}
                  agent={agent}
                  roster={roster.get(agent.id)}
                  columns={columns}
                  selected={selected.includes(agent.id)}
                  onToggleSelected={toggleSelected}
                  actions={{
                     onDuplicate: (target) =>
                        router.push(`/${orgId}/agents/new?duplicate=${target.id}`),
                     onCancelRuns: (target) => {
                        const entry = roster.get(target.id);
                        const running = entry?.running ?? 0;
                        const queued = entry?.queued ?? 0;
                        if (running + queued === 0) {
                           toast.info(t('cancelRunsNone'));
                           return;
                        }
                        setConfirm({ kind: 'cancel-runs', agent: target, running, queued });
                     },
                     onArchive: (target) =>
                        setConfirm({ kind: 'archive', agent: target, running: 0, queued: 0 }),
                     onRestore: (target) => void restore(target),
                  }}
               />
            ))
         )}

         <AlertDialog open={confirm !== null} onOpenChange={(open) => (open ? null : setConfirm(null))}>
            <AlertDialogContent>
               <AlertDialogHeader>
                  <AlertDialogTitle>
                     {confirm?.kind === 'archive'
                        ? t('archiveTitle', { name: confirm.agent.name })
                        : t('cancelRunsTitle', { name: confirm?.agent.name ?? '' })}
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                     {confirm?.kind === 'archive'
                        ? t('archiveBody')
                        : t('cancelRunsBody', {
                             running: confirm?.running ?? 0,
                             queued: confirm?.queued ?? 0,
                          })}
                  </AlertDialogDescription>
               </AlertDialogHeader>
               <AlertDialogFooter>
                  <AlertDialogCancel disabled={busy}>{common('cancel')}</AlertDialogCancel>
                  <AlertDialogAction
                     disabled={busy}
                     onClick={(event) => {
                        // Kept open until the request settles: a dialog that
                        // closes on click reports success before there is any.
                        event.preventDefault();
                        void runConfirm();
                     }}
                  >
                     {confirm?.kind === 'archive' ? t('archiveAction') : t('cancelRunsAction')}
                  </AlertDialogAction>
               </AlertDialogFooter>
            </AlertDialogContent>
         </AlertDialog>

         <Dialog open={bulkAccessOpen} onOpenChange={setBulkAccessOpen}>
            <DialogContent className="sm:max-w-md">
               <DialogHeader>
                  <DialogTitle>{t('bulkAccess')}</DialogTitle>
                  <DialogDescription>
                     {t('bulkSelected', { count: selectedRows.length })}
                  </DialogDescription>
               </DialogHeader>
               <div className="flex flex-col gap-2">
                  {(['everyone', 'admins'] as const).map((next) => (
                     <Button
                        key={next}
                        size="sm"
                        variant="secondary"
                        disabled={busy}
                        onClick={() => {
                           setBulkAccessOpen(false);
                           void bulk(t('errorTitle'), async (agent) => {
                              // The member list is the agent's own and is left
                              // alone; only the scope is being set here.
                              const current = await getAgentAccess(agent.id);
                              await setAgentAccess(agent.id, {
                                 ...current,
                                 assign: next,
                                 mention: next,
                              });
                           });
                        }}
                     >
                        {next === 'everyone' ? t('accessEveryone') : t('accessAdmins')}
                     </Button>
                  ))}
               </div>
            </DialogContent>
         </Dialog>
      </div>
   );
}
