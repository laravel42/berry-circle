'use client';

import { BerryMark } from '@/components/brand/berry-mark';
import {
   describeApprovalKind,
   describeRequestedFrom,
   getApproval,
   listWorkspaceApprovals,
   type Approval,
} from '@/lib/approvals';
import { APPROVAL_STATUS, statusLook } from '@/lib/catalog';
import { cn } from '@/lib/utils';
import { useApprovalsFilterStore } from '@/store/approvals-filter-store';
import { useApprovalsStore } from '@/store/approvals-store';
import { useMembersStore } from '@/store/members-store';
import { useSessionStore } from '@/store/session-store';
import { formatDistanceToNow, parseISO } from 'date-fns';
import { useEffect, useMemo, useState } from 'react';
import { ApprovalCard } from './approval-card';

function relativeTime(iso: string): string {
   try {
      return formatDistanceToNow(parseISO(iso), { addSuffix: true });
   } catch {
      return iso;
   }
}

function ApprovalRow({
   approval,
   selected,
   onSelect,
}: {
   approval: Approval;
   selected: boolean;
   onSelect: () => void;
}) {
   const members = useMembersStore((state) => state.members);
   const look = statusLook(APPROVAL_STATUS, approval.status);
   return (
      <li>
         <button
            type="button"
            onClick={onSelect}
            aria-current={selected ? 'true' : undefined}
            className={cn(
               'flex w-full items-start gap-3 border-b border-border/60 px-4 py-3 text-left transition-colors hover:bg-sidebar/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
               selected && 'bg-accent/50'
            )}
         >
            <BerryMark size="sm" tone={look.tone} state={look.state} className="mt-1" />
            <span className="min-w-0 flex-1">
               <span className="block truncate font-medium">{approval.title}</span>
               <span className="mt-0.5 block truncate text-muted-foreground">
                  {describeApprovalKind(approval.kind)} · asked of{' '}
                  {describeRequestedFrom(approval.requestedFrom, members)}
                  {approval.issue && ` · ${approval.issue.identifier}`}
               </span>
            </span>
            <span className="shrink-0 text-muted-foreground">
               {relativeTime(approval.requestedAt)}
            </span>
         </button>
      </li>
   );
}

function Group({
   title,
   approvals,
   selectedId,
   onSelect,
}: {
   title: string;
   approvals: Approval[];
   selectedId: string;
   onSelect: (id: string) => void;
}) {
   if (approvals.length === 0) return null;
   return (
      <>
         <li className="sticky top-0 z-10 border-b bg-container px-4 py-1.5 text-muted-foreground">
            {title} · {approvals.length}
         </li>
         {approvals.map((approval) => (
            <ApprovalRow
               key={approval.id}
               approval={approval}
               selected={approval.id === selectedId}
               onSelect={() => onSelect(approval.id)}
            />
         ))}
      </>
   );
}

/**
 * Every decision in the workspace, pending first, with the selected one
 * ready to decide beside the list. "Mine" asks the server which pending
 * approvals this person may resolve — the addressee rule lives there.
 */
export default function Approvals() {
   const approvals = useApprovalsStore((state) => state.approvals);
   const loaded = useApprovalsStore((state) => state.loaded);
   const error = useApprovalsStore((state) => state.error);
   const upsertApproval = useApprovalsStore((state) => state.upsertApproval);
   const workspaceId = useSessionStore((state) => state.workspace?.id);
   const userId = useSessionStore((state) => state.user?.id);
   const status = useSessionStore((state) => state.status);
   const { view, mine, selectedId, select } = useApprovalsFilterStore();
   const [mineIds, setMineIds] = useState<Set<string> | null>(null);

   useEffect(() => {
      if (!mine || !workspaceId || status !== 'ready') {
         setMineIds(null);
         return;
      }
      let cancelled = false;
      void listWorkspaceApprovals(workspaceId, { mine: true })
         .then((found) => {
            if (!cancelled) setMineIds(new Set(found.map((approval) => approval.id)));
         })
         .catch(() => {
            if (!cancelled) setMineIds(new Set());
         });
      return () => {
         cancelled = true;
      };
   }, [mine, workspaceId, status, approvals]);

   // A deep link (from the inbox, a run, a task) may name an approval the
   // list has not loaded — read it on its own rather than show nothing.
   useEffect(() => {
      if (status !== 'ready' || !selectedId) return;
      if (approvals.some((approval) => approval.id === selectedId)) return;
      let cancelled = false;
      void getApproval(selectedId)
         .then((approval) => {
            if (!cancelled) upsertApproval(approval);
         })
         .catch(() => undefined);
      return () => {
         cancelled = true;
      };
   }, [status, selectedId, approvals, upsertApproval]);

   const { pending, resolved } = useMemo(() => {
      const visible = approvals.filter((approval) => {
         if (!mine) return true;
         if (approval.status === 'pending') return mineIds?.has(approval.id) ?? false;
         return approval.resolvedBy === userId;
      });
      return {
         pending: visible.filter((approval) => approval.status === 'pending'),
         resolved: visible.filter((approval) => approval.status !== 'pending'),
      };
   }, [approvals, mine, mineIds, userId]);

   const selected =
      approvals.find((approval) => approval.id === selectedId) ??
      (view !== 'resolved' ? pending[0] : resolved[0]);
   const empty =
      (view === 'pending' && pending.length === 0) ||
      (view === 'resolved' && resolved.length === 0) ||
      (view === 'all' && pending.length === 0 && resolved.length === 0);

   return (
      <div className="grid h-full min-h-0 w-full grid-cols-1 overflow-hidden bg-container md:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
         <div className="min-h-0 overflow-y-auto border-b md:border-r md:border-b-0">
            {!loaded && !error ? (
               <p className="px-4 py-10 text-muted-foreground">Loading approvals…</p>
            ) : error ? (
               <p className="px-4 py-10 text-muted-foreground" role="alert">
                  {error}
               </p>
            ) : empty ? (
               <div className="flex min-h-64 items-center justify-center px-6 py-12">
                  <div className="flex max-w-xs flex-col items-center text-center">
                     <BerryMark size="lg" tone="neutral" state="hollow" label="No approvals" />
                     <h2 className="mt-5 font-display tracking-[-0.025em]">
                        {view === 'resolved' ? 'Nothing decided yet.' : 'Nothing to decide.'}
                     </h2>
                     <p className="mt-2 leading-relaxed text-muted-foreground">
                        {mine
                           ? 'No pending approval is addressed to you.'
                           : 'Approvals appear here when a plan, a task or a workflow step needs a person to say yes.'}
                     </p>
                  </div>
               </div>
            ) : (
               <ul>
                  {view !== 'resolved' && (
                     <Group
                        title="Pending"
                        approvals={pending}
                        selectedId={selected?.id ?? ''}
                        onSelect={select}
                     />
                  )}
                  {view !== 'pending' && (
                     <Group
                        title="Resolved"
                        approvals={resolved}
                        selectedId={selected?.id ?? ''}
                        onSelect={select}
                     />
                  )}
               </ul>
            )}
         </div>
         <div className="min-h-0 overflow-y-auto">
            <div className="mx-auto max-w-3xl px-6 py-6 sm:px-8">
               {selected ? (
                  <ApprovalCard approval={selected} />
               ) : (
                  <p className="text-muted-foreground">Select an approval to see what it gates.</p>
               )}
            </div>
         </div>
      </div>
   );
}
