'use client';

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
import {
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuItem,
   DropdownMenuLabel,
   DropdownMenuSeparator,
   DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { priorities } from '@/data/priorities';
import { status as allStatus } from '@/data/status';
import { loadWorkspaceAgents } from '@/lib/agents';
import { apiPriorityFromUi, apiStatusFromUi } from '@/lib/catalog';
import { batchDeleteIssues, batchUpdateIssues, loadAssigneeFrequency } from '@/lib/issue-tracking';
import { getBoardIssue } from '@/lib/issues';
import { loadWorkspaceMembers } from '@/lib/members';
import { useIssueSelectionStore } from '@/store/issue-selection-store';
import { useIssuesStore } from '@/store/issues-store';
import { useSessionStore } from '@/store/session-store';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useRunConfirm } from './run-confirm-dialog';

type Candidate = { type: 'user' | 'agent'; id: string; name: string };

/**
 * Appears while tasks are selected. Each change is applied per task on the
 * server, and anything it could not change is reported by count.
 *
 * Handing work to an agent goes through a confirmation first: it starts a run,
 * which spends, and a menu click is not consent for twenty of them.
 */
export function BatchToolbar({ visibleIds = [] }: { visibleIds?: string[] }) {
   const t = useTranslations('issueLists');
   const { selected, clear, setAll } = useIssueSelectionStore();
   const updateIssue = useIssuesStore((state) => state.updateIssue);
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? '');
   const [candidates, setCandidates] = useState<Candidate[]>([]);
   const [confirmingDelete, setConfirmingDelete] = useState(false);
   const runConfirm = useRunConfirm();

   useEffect(() => {
      if (!workspaceId || selected.length === 0 || candidates.length > 0) return;
      void Promise.all([
         loadAssigneeFrequency(workspaceId),
         loadWorkspaceMembers(workspaceId),
         loadWorkspaceAgents(),
      ])
         .then(([frequent, members, agents]) => {
            const named: Candidate[] = [
               ...members.map((member) => ({
                  type: 'user' as const,
                  id: member.id,
                  name: member.name,
               })),
               ...agents.map((agent) => ({
                  type: 'agent' as const,
                  id: agent.id,
                  name: agent.name,
               })),
            ];
            const rank = (candidate: Candidate) =>
               frequent.find((entry) => entry.type === candidate.type && entry.id === candidate.id)
                  ?.count ?? 0;
            setCandidates(
               named.sort((a, b) => rank(b) - rank(a) || a.name.localeCompare(b.name)).slice(0, 12)
            );
         })
         .catch(() => undefined);
   }, [workspaceId, selected.length, candidates.length]);

   if (selected.length === 0) return null;

   const refresh = async (ids: string[]) => {
      for (const id of ids) {
         const fresh = await getBoardIssue(id);
         if (fresh) updateIssue(id, fresh);
      }
   };

   const apply = (patch: Parameters<typeof batchUpdateIssues>[1]) =>
      void batchUpdateIssues(selected, patch)
         .then(async (result) => {
            await refresh(result.updated);
            if (result.failed.length > 0) {
               toast.error(t('selection.changeFailed', { count: result.failed.length }));
            }
            clear();
         })
         .catch(() => toast.error(t('selection.changeError')));

   const assign = (candidate: Candidate) => {
      if (candidate.type !== 'agent') {
         apply({ assignee: { type: candidate.type, id: candidate.id } });
         return;
      }
      // Handing a selection to an agent is two decisions: assign, and start.
      // Answering "assign only" parks the tasks in the backlog, the one state
      // an assigned agent is never dispatched from.
      void runConfirm
         .ask({ target: { kind: 'agent', name: candidate.name }, count: selected.length })
         .then((start) => {
            if (start === null) return;
            apply({
               assignee: { type: 'agent', id: candidate.id },
               ...(start ? {} : { status: 'backlog' }),
            });
         });
   };

   const remove = () => {
      setConfirmingDelete(false);
      void batchDeleteIssues(selected)
         .then((result) => {
            useIssuesStore.setState((state) => ({
               issues: state.issues.filter((issue) => !result.deleted.includes(issue.id)),
            }));
            if (result.failed.length > 0) {
               toast.error(t('selection.deleteFailed', { count: result.failed.length }));
            }
            clear();
         })
         .catch(() => toast.error(t('selection.deleteError')));
   };

   const allVisibleSelected =
      visibleIds.length > 0 && visibleIds.every((id) => selected.includes(id));

   return (
      <>
         <div className="flex items-center gap-2 border-b bg-accent/40 px-4 py-1.5">
            <span>{t('selection.count', { count: selected.length })}</span>
            {visibleIds.length > 0 && !allVisibleSelected ? (
               <Button size="xs" variant="ghost" onClick={() => setAll(visibleIds)}>
                  {t('selection.selectAll')}
               </Button>
            ) : null}
            <DropdownMenu>
               <DropdownMenuTrigger asChild>
                  <Button size="xs" variant="secondary">
                     {t('display.status')}
                  </Button>
               </DropdownMenuTrigger>
               <DropdownMenuContent>
                  {allStatus.map((entry) => (
                     <DropdownMenuItem
                        key={entry.id}
                        onClick={() => apply({ status: apiStatusFromUi(entry.id) })}
                     >
                        {entry.name}
                     </DropdownMenuItem>
                  ))}
               </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
               <DropdownMenuTrigger asChild>
                  <Button size="xs" variant="secondary">
                     {t('display.priority')}
                  </Button>
               </DropdownMenuTrigger>
               <DropdownMenuContent>
                  {priorities.map((entry) => (
                     <DropdownMenuItem
                        key={entry.id}
                        onClick={() => apply({ priority: apiPriorityFromUi(entry.id) })}
                     >
                        {entry.name}
                     </DropdownMenuItem>
                  ))}
               </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
               <DropdownMenuTrigger asChild>
                  <Button size="xs" variant="secondary">
                     {t('display.assignee')}
                  </Button>
               </DropdownMenuTrigger>
               <DropdownMenuContent>
                  <DropdownMenuLabel>{t('selection.frequentFirst')}</DropdownMenuLabel>
                  {candidates.map((candidate) => (
                     <DropdownMenuItem
                        key={`${candidate.type}:${candidate.id}`}
                        onClick={() => assign(candidate)}
                     >
                        {candidate.name}
                     </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => apply({ assignee: null })}>
                     {t('filters.noAssignee')}
                  </DropdownMenuItem>
               </DropdownMenuContent>
            </DropdownMenu>
            <Button size="xs" variant="ghost" onClick={() => setConfirmingDelete(true)}>
               {t('selection.delete')}
            </Button>
            <Button size="xs" variant="ghost" className="ml-auto" onClick={clear}>
               {t('selection.clear')}
            </Button>
         </div>

         <AlertDialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
            <AlertDialogContent>
               <AlertDialogHeader>
                  <AlertDialogTitle>{t('selection.deleteTitle')}</AlertDialogTitle>
                  <AlertDialogDescription>
                     {t('selection.deleteBody', { count: selected.length })}
                  </AlertDialogDescription>
               </AlertDialogHeader>
               <AlertDialogFooter>
                  <AlertDialogCancel>{t('selection.cancel')}</AlertDialogCancel>
                  <AlertDialogAction
                     onClick={(event) => {
                        event.preventDefault();
                        remove();
                     }}
                  >
                     {t('selection.delete')}
                  </AlertDialogAction>
               </AlertDialogFooter>
            </AlertDialogContent>
         </AlertDialog>

         {runConfirm.dialog}
      </>
   );
}
