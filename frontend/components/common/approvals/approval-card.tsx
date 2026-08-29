'use client';

import { BerryMark } from '@/components/brand/berry-mark';
import { Pill } from '@/components/common/plans/plan-sections';
import {
   AlertDialog,
   AlertDialogAction,
   AlertDialogCancel,
   AlertDialogContent,
   AlertDialogDescription,
   AlertDialogFooter,
   AlertDialogHeader,
   AlertDialogTitle,
   AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button, buttonVariants } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
   approvalRefusalReason,
   approveApproval,
   describeApprovalExpiry,
   describeApprovalFailure,
   describeApprovalKind,
   describeRequestedFrom,
   isApprovalPending,
   rejectApproval,
   type Approval,
} from '@/lib/approvals';
import { APPROVAL_STATUS, statusLook } from '@/lib/catalog';
import { WORKSPACE_SLUG } from '@/lib/config';
import { cn } from '@/lib/utils';
import { useApprovalsStore } from '@/store/approvals-store';
import { useGoalsStore } from '@/store/goals-store';
import { useMembersStore } from '@/store/members-store';
import { format, parseISO } from 'date-fns';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

const RISK_TONE = { low: 'neutral', medium: 'attention', high: 'danger' } as const;

function whenText(iso: string | null | undefined): string {
   if (!iso) return '';
   try {
      return format(parseISO(iso), 'd MMM, HH:mm');
   } catch {
      return iso;
   }
}

interface ApprovalCardProps {
   approval: Approval;
   /** Tighter padding and no note field for the inbox pane. */
   compact?: boolean;
   className?: string;
}

/**
 * One approval and the decision it asks for. Who may decide is the server's
 * rule — the addressee, or anyone holding the addressed role or a stronger
 * one — so the buttons stay live until a refusal comes back, and then the
 * card says in words why this person cannot decide it.
 */
export function ApprovalCard({ approval, compact = false, className }: ApprovalCardProps) {
   const params = useParams<{ orgId?: string }>();
   const orgId = params?.orgId || WORKSPACE_SLUG;
   const members = useMembersStore((state) => state.members);
   const upsertApproval = useApprovalsStore((state) => state.upsertApproval);
   const goalTitle = useGoalsStore((state) =>
      approval.goalId ? state.goals.find((goal) => goal.id === approval.goalId)?.title : undefined
   );
   const [busy, setBusy] = useState<'approving' | 'rejecting' | null>(null);
   const [refusal, setRefusal] = useState<'not_addressee' | 'admin_required' | null>(null);
   const [note, setNote] = useState('');

   const pending = isApprovalPending(approval);
   const look = statusLook(APPROVAL_STATUS, approval.status);
   const expiry = describeApprovalExpiry(approval.expiresAt);

   const decide = async (decision: 'approve' | 'reject') => {
      setBusy(decision === 'approve' ? 'approving' : 'rejecting');
      try {
         const updated =
            decision === 'approve'
               ? await approveApproval(approval.id, note)
               : await rejectApproval(approval.id, note);
         upsertApproval(updated);
         toast.success(decision === 'approve' ? 'Approved' : 'Rejected');
         setNote('');
      } catch (error) {
         const reason = approvalRefusalReason(error);
         if (reason) setRefusal(reason);
         toast.error(describeApprovalFailure(error));
      } finally {
         setBusy(null);
      }
   };

   const refusalText =
      refusal === 'admin_required'
         ? 'An admin has to decide this one.'
         : refusal === 'not_addressee'
           ? 'This approval is addressed to someone else.'
           : null;

   const links: { href: string; label: string }[] = [];
   if (approval.issue) {
      links.push({
         href: `/${orgId}/issue/${approval.issue.identifier}`,
         label: `${approval.issue.identifier} ${approval.issue.title}`,
      });
   }
   if (approval.goalId) {
      links.push({
         href: `/${orgId}/goal/${approval.goalId}/overview`,
         label: goalTitle ?? 'goal',
      });
   }
   if (approval.planId) {
      links.push({ href: `/${orgId}/plan/${approval.planId}`, label: 'plan' });
   }

   return (
      <div
         className={cn(
            'rounded-md border border-border/60 bg-background',
            compact ? 'px-3 py-2.5' : 'px-4 py-3',
            className
         )}
      >
         <div className="flex items-start gap-3">
            <BerryMark size="sm" tone={look.tone} state={look.state} className="mt-1" />
            <div className="min-w-0 flex-1">
               <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-medium">{approval.title}</span>
                  <Pill tone={RISK_TONE[approval.risk]}>{approval.risk} risk</Pill>
                  <Pill>{describeApprovalKind(approval.kind)}</Pill>
                  {!pending && (
                     <Pill tone={approval.status === 'approved' ? 'complete' : 'danger'}>
                        {look.label}
                     </Pill>
                  )}
               </div>
               {approval.description && (
                  <p className="mt-1 whitespace-pre-line text-muted-foreground">
                     {approval.description}
                  </p>
               )}
               <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
                  <span>asked of {describeRequestedFrom(approval.requestedFrom, members)}</span>
                  <span>{whenText(approval.requestedAt)}</span>
                  {pending && expiry && (
                     <span
                        className={
                           expiry === 'expired' ? 'text-status-danger' : 'text-status-warning'
                        }
                     >
                        {expiry}
                     </span>
                  )}
               </p>
               {links.length > 0 && (
                  <ul className="mt-2 flex flex-wrap gap-1.5">
                     {links.map((link) => (
                        <li key={link.href}>
                           <Link
                              href={link.href}
                              className="inline-flex max-w-72 items-center rounded-md border border-border/60 px-2 py-0.5 hover:bg-accent"
                           >
                              <span className="truncate">{link.label}</span>
                           </Link>
                        </li>
                     ))}
                  </ul>
               )}
               {!pending && (approval.resolvedAt || approval.decisionNote) && (
                  <p className="mt-2 text-muted-foreground">
                     {look.label}
                     {approval.resolvedAt && ` · ${whenText(approval.resolvedAt)}`}
                     {approval.decisionNote && ` · “${approval.decisionNote}”`}
                  </p>
               )}
               {pending && (
                  <div className="mt-3 flex flex-col gap-2">
                     {!compact && (
                        <Textarea
                           value={note}
                           onChange={(event) => setNote(event.target.value)}
                           placeholder="Add a note (optional)"
                           rows={2}
                           aria-label="Decision note"
                           className="min-h-0"
                        />
                     )}
                     <div className="flex flex-wrap items-center gap-2">
                        <Button
                           size="xs"
                           disabled={busy !== null || refusal !== null}
                           title={refusalText ?? undefined}
                           onClick={() => void decide('approve')}
                        >
                           {busy === 'approving' ? 'Approving…' : 'Approve'}
                        </Button>
                        <AlertDialog>
                           <AlertDialogTrigger asChild>
                              <Button
                                 size="xs"
                                 variant="secondary"
                                 disabled={busy !== null || refusal !== null}
                                 title={refusalText ?? undefined}
                              >
                                 {busy === 'rejecting' ? 'Rejecting…' : 'Reject'}
                              </Button>
                           </AlertDialogTrigger>
                           <AlertDialogContent>
                              <AlertDialogHeader>
                                 <AlertDialogTitle>Reject “{approval.title}”?</AlertDialogTitle>
                                 <AlertDialogDescription>
                                    Whatever this approval gates stays where it is. A note tells the
                                    person who asked why.
                                 </AlertDialogDescription>
                              </AlertDialogHeader>
                              <Textarea
                                 value={note}
                                 onChange={(event) => setNote(event.target.value)}
                                 placeholder="Why not? (optional)"
                                 rows={3}
                                 aria-label="Rejection note"
                              />
                              <AlertDialogFooter>
                                 <AlertDialogCancel>Keep</AlertDialogCancel>
                                 <AlertDialogAction
                                    className={buttonVariants({ variant: 'destructive' })}
                                    onClick={() => void decide('reject')}
                                 >
                                    Reject
                                 </AlertDialogAction>
                              </AlertDialogFooter>
                           </AlertDialogContent>
                        </AlertDialog>
                        {refusalText && (
                           <span role="status" className="text-muted-foreground">
                              {refusalText}
                           </span>
                        )}
                     </div>
                  </div>
               )}
            </div>
         </div>
      </div>
   );
}
