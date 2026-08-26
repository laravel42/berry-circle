'use client';

import { BerryMark } from '@/components/brand/berry-mark';
import { WORKFLOW_RUN_STATUS, WORKFLOW_STATUS, statusLook } from '@/lib/catalog';
import { WORKSPACE_SLUG } from '@/lib/config';
import type { Workflow } from '@/lib/workflows';
import { formatDistanceToNow, parseISO } from 'date-fns';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { WorkflowStatusBadge } from './workflow-status-badge';
import { WorkflowTriggerLabel } from './workflow-trigger-label';

function relativeTime(iso: string): string {
   try {
      return formatDistanceToNow(parseISO(iso), { addSuffix: true });
   } catch {
      return iso;
   }
}

/** One row of the workflows list: name, status, trigger, last run, run counts. */
export default function WorkflowLine({ workflow }: { workflow: Workflow }) {
   const params = useParams<{ orgId?: string }>();
   const orgId = params?.orgId || WORKSPACE_SLUG;
   const look = statusLook(WORKFLOW_STATUS, workflow.status);
   const lastRun = workflow.lastRun
      ? statusLook(WORKFLOW_RUN_STATUS, workflow.lastRun.status)
      : null;

   return (
      <Link
         href={`/${orgId}/workflow/${workflow.id}/overview`}
         className="flex w-full items-center border-b border-muted-foreground/5 px-6 py-3 last:border-b-0 hover:bg-sidebar/50"
      >
         <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted/40">
               <BerryMark size="sm" tone={look.tone} state={look.state} label={look.label} />
            </span>
            <div className="min-w-0 overflow-hidden">
               <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-medium leading-none">{workflow.name}</span>
                  {workflow.risk === 'high' && (
                     <span className="shrink-0 rounded border border-border px-1.5 py-px uppercase tracking-wide text-status-danger">
                        high risk
                     </span>
                  )}
               </div>
               {workflow.description ? (
                  <p className="mt-0.5 line-clamp-1 text-muted-foreground">
                     {workflow.description}
                  </p>
               ) : null}
            </div>
         </div>

         <div className="w-27.5 shrink-0">
            <WorkflowStatusBadge status={workflow.status} />
         </div>

         <div className="hidden w-56 shrink-0 text-muted-foreground lg:block">
            <WorkflowTriggerLabel trigger={workflow.trigger} className="max-w-full" />
         </div>

         <div className="hidden w-40 shrink-0 text-muted-foreground sm:block">
            {workflow.lastRun && lastRun ? (
               <span className="inline-flex items-center gap-1.5">
                  <BerryMark
                     size="sm"
                     tone={lastRun.tone}
                     state={lastRun.state}
                     pulse={lastRun.pulse}
                  />
                  <span className="truncate">
                     {lastRun.label.toLowerCase()} · {relativeTime(workflow.lastRun.createdAt)}
                  </span>
               </span>
            ) : (
               <span>never run</span>
            )}
         </div>

         <div className="w-16 shrink-0 text-right tabular-nums text-muted-foreground">
            {workflow.runCounts.total}
            {workflow.runCounts.failed > 0 && (
               <span className="text-status-danger"> · {workflow.runCounts.failed}</span>
            )}
         </div>
      </Link>
   );
}
