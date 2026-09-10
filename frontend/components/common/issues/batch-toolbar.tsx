'use client';

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
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

type Candidate = { type: 'user' | 'agent'; id: string; name: string };

/**
 * Appears while tasks are selected. Each change is applied per task on the
 * server, and anything it could not change is reported by count.
 */
export function BatchToolbar() {
   const { selected, clear } = useIssueSelectionStore();
   const updateIssue = useIssuesStore((state) => state.updateIssue);
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? '');
   const [candidates, setCandidates] = useState<Candidate[]>([]);

   useEffect(() => {
      if (!workspaceId || selected.length === 0 || candidates.length > 0) return;
      void Promise.all([loadAssigneeFrequency(workspaceId), loadWorkspaceMembers(workspaceId), loadWorkspaceAgents()])
         .then(([frequent, members, agents]) => {
            const named: Candidate[] = [
               ...members.map((member) => ({ type: 'user' as const, id: member.id, name: member.name })),
               ...agents.map((agent) => ({ type: 'agent' as const, id: agent.id, name: agent.name })),
            ];
            const rank = (candidate: Candidate) =>
               frequent.find((entry) => entry.type === candidate.type && entry.id === candidate.id)?.count ?? 0;
            setCandidates(named.sort((a, b) => rank(b) - rank(a) || a.name.localeCompare(b.name)).slice(0, 12));
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
            if (result.failed.length > 0) toast.error(`${result.failed.length} task(s) could not be changed.`);
            clear();
         })
         .catch(() => toast.error('The change could not be applied.'));

   const remove = () => {
      if (!window.confirm(`Delete ${selected.length} task(s)?`)) return;
      void batchDeleteIssues(selected)
         .then((result) => {
            useIssuesStore.setState((state) => ({ issues: state.issues.filter((issue) => !result.deleted.includes(issue.id)) }));
            if (result.failed.length > 0) toast.error(`${result.failed.length} task(s) could not be deleted.`);
            clear();
         })
         .catch(() => toast.error('The tasks could not be deleted.'));
   };

   return (
      <div className="flex items-center gap-2 border-b bg-accent/40 px-4 py-1.5">
         <span>{selected.length} selected</span>
         <DropdownMenu>
            <DropdownMenuTrigger asChild>
               <Button size="xs" variant="secondary">Status</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
               {allStatus.map((entry) => (
                  <DropdownMenuItem key={entry.id} onClick={() => apply({ status: apiStatusFromUi(entry.id) })}>
                     {entry.name}
                  </DropdownMenuItem>
               ))}
            </DropdownMenuContent>
         </DropdownMenu>
         <DropdownMenu>
            <DropdownMenuTrigger asChild>
               <Button size="xs" variant="secondary">Priority</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
               {priorities.map((entry) => (
                  <DropdownMenuItem key={entry.id} onClick={() => apply({ priority: apiPriorityFromUi(entry.id) })}>
                     {entry.name}
                  </DropdownMenuItem>
               ))}
            </DropdownMenuContent>
         </DropdownMenu>
         <DropdownMenu>
            <DropdownMenuTrigger asChild>
               <Button size="xs" variant="secondary">Assign</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
               <DropdownMenuLabel>Most assigned by you first</DropdownMenuLabel>
               {candidates.map((candidate) => (
                  <DropdownMenuItem key={`${candidate.type}:${candidate.id}`} onClick={() => apply({ assignee: { type: candidate.type, id: candidate.id } })}>
                     {candidate.name}
                  </DropdownMenuItem>
               ))}
               <DropdownMenuSeparator />
               <DropdownMenuItem onClick={() => apply({ assignee: null })}>Unassign</DropdownMenuItem>
            </DropdownMenuContent>
         </DropdownMenu>
         <Button size="xs" variant="ghost" onClick={remove}>
            Delete
         </Button>
         <Button size="xs" variant="ghost" className="ml-auto" onClick={clear}>
            Clear
         </Button>
      </div>
   );
}
