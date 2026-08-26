'use client';

import { BerryMark } from '@/components/brand/berry-mark';
import { CancelRunButton } from '@/components/common/workflows/workflow-run-detail';
import { WorkflowRunStatusBadge } from '@/components/common/workflows/workflow-status-badge';
import { WORKFLOW_RUN_STATUS, statusLook } from '@/lib/catalog';
import { WORKSPACE_SLUG } from '@/lib/config';
import { shortRunId } from '@/lib/workflow-runs';
import { useWorkflowRunsStore } from '@/store/workflow-runs-store';
import { useWorkflowsStore } from '@/store/workflows-store';
import { ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';

/** Run header: automations › workflow › run, its status, and Cancel while it goes. */
export default function Header({ workflowId, runId }: { workflowId: string; runId: string }) {
   const params = useParams<{ orgId?: string }>();
   const orgId = params?.orgId || WORKSPACE_SLUG;
   const workflow = useWorkflowsStore((state) =>
      state.workflows.find((candidate) => candidate.id === workflowId)
   );
   const run = useWorkflowRunsStore((state) => state.runs[runId]);
   const look = run ? statusLook(WORKFLOW_RUN_STATUS, run.status) : null;

   return (
      <div className="flex h-10 w-full items-center justify-between gap-4 border-b px-6 py-1.5">
         <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5">
            <Link
               href={`/${orgId}/workflows`}
               className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
            >
               Automations
            </Link>
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <Link
               href={`/${orgId}/workflow/${workflowId}/overview`}
               className="min-w-0 truncate text-muted-foreground transition-colors hover:text-foreground"
            >
               {workflow?.name ?? 'workflow'}
            </Link>
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <BerryMark
               size="sm"
               tone={look?.tone ?? 'neutral'}
               state={look?.state ?? 'hollow'}
               pulse={look?.pulse}
            />
            <span className="truncate font-medium">run {shortRunId(runId)}</span>
         </nav>
         <div className="flex shrink-0 items-center gap-2">
            {run && (
               <WorkflowRunStatusBadge status={run.status} className="hidden sm:inline-flex" />
            )}
            {run && <CancelRunButton run={run} />}
         </div>
      </div>
   );
}
