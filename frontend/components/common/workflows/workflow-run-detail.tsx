'use client';

import { Button } from '@/components/ui/button';
import { useWorkflowRun } from '@/hooks/use-workflow-run';
import { WORKSPACE_SLUG } from '@/lib/config';
import {
   cancelWorkflowRun,
   describeTriggerType,
   describeWaitingOn,
   describeWorkflowRunDuration,
   describeWorkflowRunFailure,
   isTerminalWorkflowRunStatus,
   shortRunId,
   waitingOnHref,
   type WorkflowRun,
} from '@/lib/workflow-runs';
import { cn } from '@/lib/utils';
import { useWorkflowRunsStore } from '@/store/workflow-runs-store';
import { useWorkflowsStore } from '@/store/workflows-store';
import { format, parseISO } from 'date-fns';
import { ArrowUpRight } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { WorkflowRunLedger, WorkflowRunSteps } from './workflow-run-steps';
import { WorkflowRunStatusBadge } from './workflow-status-badge';

function whenText(iso: string | null | undefined): string {
   if (!iso) return '—';
   try {
      return format(parseISO(iso), 'd MMM yyyy, HH:mm:ss');
   } catch {
      return iso;
   }
}

function pretty(value: unknown): string | null {
   if (value === null || value === undefined) return null;
   try {
      const text = JSON.stringify(value, null, 2);
      return text === '{}' || text === 'null' ? null : text;
   } catch {
      return null;
   }
}

/** Cancel, for a run that is still going. */
export function CancelRunButton({ run, className }: { run: WorkflowRun; className?: string }) {
   const upsertRun = useWorkflowRunsStore((state) => state.upsertRun);
   const [cancelling, setCancelling] = useState(false);
   if (isTerminalWorkflowRunStatus(run.status)) return null;
   return (
      <Button
         variant="ghost"
         size="xs"
         className={className}
         disabled={cancelling}
         onClick={() => {
            setCancelling(true);
            void cancelWorkflowRun(run.id)
               .then((updated) => {
                  upsertRun(updated);
                  toast.success('Run cancelled');
               })
               .catch((error: unknown) => toast.error(describeWorkflowRunFailure(error)))
               .finally(() => setCancelling(false));
         }}
      >
         {cancelling ? 'Cancelling…' : 'Cancel run'}
      </Button>
   );
}

interface WorkflowRunDetailProps {
   runId: string;
   /** Fewer facts and no ledger header, for a panel above a table. */
   compact?: boolean;
   className?: string;
}

/**
 * One run: what started it, where it is, what each step did, and the
 * ledger as it is written. A run is read separately from the tasks it
 * creates — the tasks are on the board, the run is here.
 */
export function WorkflowRunDetail({ runId, compact = false, className }: WorkflowRunDetailProps) {
   const params = useParams<{ orgId?: string }>();
   const orgId = params?.orgId || WORKSPACE_SLUG;
   const { run, error, loading } = useWorkflowRun(runId);
   const workflow = useWorkflowsStore((state) =>
      run ? state.workflows.find((candidate) => candidate.id === run.workflowId) : undefined
   );

   if (!run) {
      return (
         <div
            className={cn('p-6 text-muted-foreground', className)}
            role={error ? 'alert' : 'status'}
         >
            {error ?? (loading ? 'Loading run…' : 'Run not found.')}
         </div>
      );
   }

   const duration = describeWorkflowRunDuration(run);
   const waiting = describeWaitingOn(run.waitingOn);
   const waitingHref = waitingOnHref(run.waitingOn, orgId);
   const tokens = run.usage.inputTokens + run.usage.outputTokens;
   const facts: { label: string; value: ReactNode }[] = [
      { label: 'Status', value: <WorkflowRunStatusBadge status={run.status} /> },
      { label: 'Trigger', value: describeTriggerType(run.triggerType) },
      { label: 'Version', value: `v${run.workflowVersion}` },
      { label: 'Created', value: whenText(run.createdAt) },
      { label: 'Started', value: whenText(run.startedAt) },
      { label: 'Duration', value: duration ?? '—' },
      { label: 'Tokens', value: tokens > 0 ? tokens.toLocaleString() : '—' },
   ];
   if (run.currentStepId && !isTerminalWorkflowRunStatus(run.status)) {
      facts.push({ label: 'Current step', value: run.currentStepId });
   }
   const payload = pretty(run.triggerPayload);

   return (
      <div className={cn('flex flex-col gap-5', className)}>
         {!compact && (
            <div>
               <h1 className="text-balance font-display leading-[1.08] tracking-[-0.025em]">
                  {workflow?.name ?? 'Workflow'} · run {shortRunId(run.id)}
               </h1>
               <p className="mt-1 text-muted-foreground">
                  {describeTriggerType(run.triggerType)}
                  {duration && ` · ${duration}`}
               </p>
            </div>
         )}

         {(waiting || run.failure) && (
            <div
               role={run.failure ? 'alert' : 'status'}
               className={cn(
                  'rounded-md border border-border/60 bg-background px-4 py-3',
                  run.failure ? 'text-status-danger' : 'text-status-warning'
               )}
            >
               {run.failure ? (
                  <>
                     <span className="font-medium">{run.failure.code}</span> · {run.failure.message}
                  </>
               ) : (
                  <>
                     {waiting}
                     {waitingHref && (
                        <Link href={waitingHref} className="ml-2 underline underline-offset-2">
                           open
                        </Link>
                     )}
                  </>
               )}
            </div>
         )}

         <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
            {facts.map((fact) => (
               <div key={fact.label} className="min-w-0">
                  <dt className="text-muted-foreground">{fact.label}</dt>
                  <dd className="mt-0.5 truncate">{fact.value}</dd>
               </div>
            ))}
         </dl>

         <div className="flex flex-wrap items-center gap-2">
            <CancelRunButton run={run} />
            {compact && (
               <Button asChild variant="ghost" size="xs">
                  <Link href={`/${orgId}/workflow/${run.workflowId}/run/${run.id}`}>
                     Open run
                     <ArrowUpRight className="size-3.5" />
                  </Link>
               </Button>
            )}
            {!compact && workflow && (
               <Button asChild variant="ghost" size="xs">
                  <Link href={`/${orgId}/workflow/${workflow.id}/overview`}>
                     Open workflow
                     <ArrowUpRight className="size-3.5" />
                  </Link>
               </Button>
            )}
         </div>

         <section>
            <h3 className="mb-2 font-medium">Steps</h3>
            <WorkflowRunSteps run={run} />
         </section>

         <WorkflowRunLedger runId={run.id} />

         {payload && (
            <details className="rounded-md border border-border/60 bg-background px-3 py-2">
               <summary className="cursor-pointer font-medium">Trigger payload</summary>
               <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all font-mono leading-5">
                  {payload}
               </pre>
            </details>
         )}
      </div>
   );
}
