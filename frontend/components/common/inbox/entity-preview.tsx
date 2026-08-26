'use client';

import { ApprovalCard } from '@/components/common/approvals/approval-card';
import { Button } from '@/components/ui/button';
import type { InboxItem } from '@/data/inbox';
import { getApproval, type Approval } from '@/lib/approvals';
import { WORKSPACE_SLUG } from '@/lib/config';
import { useApprovalsStore } from '@/store/approvals-store';
import { useGoalsStore } from '@/store/goals-store';
import { useSessionStore } from '@/store/session-store';
import { useWorkflowRunsStore } from '@/store/workflow-runs-store';
import { ArrowUpRight } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';

/** Where a non-task notification leads, for the header's Open link. */
export function inboxEntityHref(notification: InboxItem, orgId: string): string | null {
   if (notification.issue?.identifier) return `/${orgId}/issue/${notification.issue.identifier}`;
   if (notification.approval) {
      return `/${orgId}/approvals?approval=${encodeURIComponent(notification.approval.id)}`;
   }
   if (notification.plan) return `/${orgId}/plan/${notification.plan.id}`;
   if (notification.workflowRun) {
      return `/${orgId}/workflow-runs?run=${encodeURIComponent(notification.workflowRun.id)}`;
   }
   if (notification.goal) return `/${orgId}/goal/${notification.goal.id}/overview`;
   return null;
}

function ApprovalPreview({ approvalId }: { approvalId: string }) {
   const status = useSessionStore((state) => state.status);
   const known = useApprovalsStore((state) =>
      state.approvals.find((approval) => approval.id === approvalId)
   );
   const upsertApproval = useApprovalsStore((state) => state.upsertApproval);
   const [failed, setFailed] = useState(false);

   useEffect(() => {
      if (status !== 'ready' || known) return;
      let cancelled = false;
      void getApproval(approvalId)
         .then((approval: Approval) => {
            if (!cancelled) upsertApproval(approval);
         })
         .catch(() => {
            if (!cancelled) setFailed(true);
         });
      return () => {
         cancelled = true;
      };
   }, [status, known, approvalId, upsertApproval]);

   if (known) return <ApprovalCard approval={known} compact />;
   return (
      <p className="text-muted-foreground" role={failed ? 'alert' : 'status'}>
         {failed ? 'The approval could not be loaded.' : 'Loading approval…'}
      </p>
   );
}

/**
 * The record behind a notification that is not about a task: the approval
 * itself, ready to decide, or the way to the goal, plan or run it names.
 */
export function InboxEntityPreview({ notification }: { notification: InboxItem }) {
   const params = useParams<{ orgId?: string }>();
   const orgId = params?.orgId || WORKSPACE_SLUG;
   const goal = useGoalsStore((state) =>
      notification.goal
         ? state.goals.find((entry) => entry.id === notification.goal?.id)
         : undefined
   );
   const run = useWorkflowRunsStore((state) =>
      notification.workflowRun ? state.runs[notification.workflowRun.id] : undefined
   );

   if (notification.approval) {
      return <ApprovalPreview approvalId={notification.approval.id} />;
   }

   const target = notification.plan
      ? { label: 'Open plan', href: `/${orgId}/plan/${notification.plan.id}` }
      : notification.workflowRun
        ? {
             label: 'Open run',
             href: run
                ? `/${orgId}/workflow/${run.workflowId}/run/${run.id}`
                : `/${orgId}/workflow-runs?run=${encodeURIComponent(notification.workflowRun.id)}`,
          }
        : notification.goal
          ? { label: 'Open goal', href: `/${orgId}/goal/${notification.goal.id}/overview` }
          : null;

   return (
      <div className="rounded-md border border-border/60 bg-background px-4 py-3">
         <p className="font-medium">{goal?.title ?? notification.title}</p>
         {notification.content && notification.content !== notification.title && (
            <p className="mt-1 whitespace-pre-line text-muted-foreground">{notification.content}</p>
         )}
         {target && (
            <Button asChild size="xs" variant="secondary" className="mt-3">
               <Link href={target.href}>
                  {target.label}
                  <ArrowUpRight className="size-3.5" />
               </Link>
            </Button>
         )}
      </div>
   );
}
