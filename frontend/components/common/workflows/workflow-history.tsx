'use client';

import { BerryApiError } from '@/lib/api';
import { WORKSPACE_SLUG } from '@/lib/config';
import { subscribeWorkspaceEvents } from '@/lib/events';
import {
   describeRunTrigger,
   describeWorkflowRunDuration,
   listWorkflowRuns,
   shortRunId,
   type WorkflowRun,
} from '@/lib/workflow-runs';
import { cn } from '@/lib/utils';
import { useProvidersStore } from '@/store/providers-store';
import { useSessionStore } from '@/store/session-store';
import { useWorkflowRunsFilterStore } from '@/store/workflow-runs-filter-store';
import { useWorkflowRunsStore } from '@/store/workflow-runs-store';
import { useWorkflowsStore } from '@/store/workflows-store';
import { formatDistanceToNow, parseISO } from 'date-fns';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { WorkflowRunDetail } from './workflow-run-detail';
import { WorkflowRunStatusBadge } from './workflow-status-badge';

function relativeTime(iso: string): string {
   try {
      return formatDistanceToNow(parseISO(iso), { addSuffix: true });
   } catch {
      return iso;
   }
}

const COLUMNS = ['run', 'status', 'trigger', 'when', 'duration'] as const;

/**
 * One row per run of a workflow, newest first. Selecting a row (`?run=`)
 * opens it above the table with its steps and ledger; the full page is a
 * link away for a run worth its own tab.
 */
export function WorkflowRunsTable({
   runs,
   selectedId,
   onSelect,
   showWorkflow = false,
   emptyText,
}: {
   runs: WorkflowRun[];
   selectedId: string;
   onSelect: (runId: string) => void;
   showWorkflow?: boolean;
   emptyText: string;
}) {
   const params = useParams<{ orgId?: string }>();
   const orgId = params?.orgId || WORKSPACE_SLUG;
   const columns = showWorkflow ? (['workflow', ...COLUMNS] as const) : COLUMNS;
   return (
      <table className="w-full table-fixed text-left">
         <caption className="sr-only">Workflow runs</caption>
         <thead>
            <tr className="border-b">
               {columns.map((column) => (
                  <th
                     key={column}
                     scope="col"
                     className={cn(
                        'px-6 py-2.5 font-normal text-muted-foreground sm:px-8',
                        column === 'run' && 'w-[120px]',
                        column === 'status' && 'w-[140px]',
                        column === 'trigger' && 'hidden w-[260px] sm:table-cell',
                        column === 'when' && 'w-[140px]',
                        column === 'duration' && 'hidden w-[100px] text-right md:table-cell'
                     )}
                  >
                     {column}
                  </th>
               ))}
            </tr>
         </thead>
         <tbody>
            {runs.length === 0 ? (
               <tr>
                  <td
                     colSpan={columns.length}
                     className="px-6 py-12 leading-6 text-muted-foreground sm:px-8"
                  >
                     {emptyText}
                  </td>
               </tr>
            ) : (
               runs.map((run) => {
                  const selected = run.id === selectedId;
                  return (
                     <tr
                        key={run.id}
                        onClick={() => onSelect(run.id)}
                        className={cn(
                           'cursor-pointer border-b border-border/60 transition-colors hover:bg-sidebar/50',
                           selected && 'bg-accent/50'
                        )}
                     >
                        {showWorkflow && (
                           <td className="max-w-0 truncate px-6 py-2.5 sm:px-8">
                              <RunWorkflowName workflowId={run.workflowId} orgId={orgId} />
                           </td>
                        )}
                        <td className="px-6 py-2.5 font-mono sm:px-8">
                           {run.depth > 0 && (
                              <span
                                 className="mr-1 text-muted-foreground"
                                 title={`child run, depth ${run.depth}`}
                                 aria-label={`child run, depth ${run.depth}`}
                              >
                                 ↳
                              </span>
                           )}
                           <Link
                              href={`/${orgId}/workflow/${run.workflowId}/run/${run.id}`}
                              onClick={(event) => event.stopPropagation()}
                              className="underline-offset-2 hover:underline"
                              aria-current={selected ? 'true' : undefined}
                           >
                              {shortRunId(run.id)}
                           </Link>
                        </td>
                        <td className="px-6 py-2.5 sm:px-8">
                           <WorkflowRunStatusBadge status={run.status} />
                        </td>
                        <td className="hidden max-w-0 truncate px-6 py-2.5 sm:table-cell sm:px-8">
                           <RunTriggerCell run={run} />
                        </td>
                        <td className="px-6 py-2.5 text-muted-foreground sm:px-8">
                           {relativeTime(run.createdAt)}
                        </td>
                        <td className="hidden px-6 py-2.5 text-right tabular-nums text-muted-foreground md:table-cell sm:px-8">
                           {describeWorkflowRunDuration(run) ?? '—'}
                        </td>
                     </tr>
                  );
               })
            )}
         </tbody>
      </table>
   );
}

/** What started the run: the kind, then the instant, event or calling step in muted text. */
function RunTriggerCell({ run }: { run: WorkflowRun }) {
   const providers = useProvidersStore((state) => state.providers);
   const event = useWorkflowsStore(
      (state) => state.workflows.find((workflow) => workflow.id === run.workflowId)?.trigger.event
   );
   const summary = describeRunTrigger(run, {
      providerName: (id) => providers.find((provider) => provider.id === id)?.name,
      event,
   });
   return (
      <span
         className="text-muted-foreground"
         title={summary.detail ? `${summary.kind} · ${summary.detail}` : summary.kind}
      >
         <span className="text-foreground">{summary.kind}</span>
         {summary.detail && ` · ${summary.detail}`}
      </span>
   );
}

function RunWorkflowName({ workflowId, orgId }: { workflowId: string; orgId: string }) {
   const name = useWorkflowNameById(workflowId);
   return (
      <Link
         href={`/${orgId}/workflow/${workflowId}/overview`}
         onClick={(event) => event.stopPropagation()}
         className="underline-offset-2 hover:underline"
      >
         {name ?? 'archived workflow'}
      </Link>
   );
}

function useWorkflowNameById(workflowId: string): string | undefined {
   return useWorkflowsStore(
      (state) => state.workflows.find((workflow) => workflow.id === workflowId)?.name
   );
}

export default function WorkflowHistory({ workflowId }: { workflowId: string }) {
   const status = useSessionStore((state) => state.status);
   // Selected as the stored references and assembled here: a selector that
   // built the array would hand React a new value every render and loop.
   const runIds = useWorkflowRunsStore((state) => state.runsByWorkflowId[workflowId]);
   const runsById = useWorkflowRunsStore((state) => state.runs);
   const hydrateWorkflowRuns = useWorkflowRunsStore((state) => state.hydrateWorkflowRuns);
   const runs = useMemo(
      () =>
         (runIds ?? []).map((id) => runsById[id]).filter((run): run is WorkflowRun => Boolean(run)),
      [runIds, runsById]
   );
   const { selectedId, select } = useWorkflowRunsFilterStore();
   const [error, setError] = useState<string | null>(null);
   const [loaded, setLoaded] = useState(false);

   useEffect(() => {
      if (status !== 'ready' || !workflowId) return;
      let cancelled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const read = () => {
         void listWorkflowRuns(workflowId)
            .then((found) => {
               if (cancelled) return;
               hydrateWorkflowRuns(workflowId, found);
               setError(null);
            })
            .catch((failure: unknown) => {
               if (cancelled) return;
               setError(
                  failure instanceof BerryApiError ? failure.message : 'Runs could not be loaded.'
               );
            })
            .finally(() => {
               if (!cancelled) setLoaded(true);
            });
      };
      read();
      const unsubscribe = subscribeWorkspaceEvents((event) => {
         if (!event.type.startsWith('workflow.run.') || event.workflowId !== workflowId) return;
         if (timer) clearTimeout(timer);
         timer = setTimeout(read, 400);
      });
      return () => {
         cancelled = true;
         unsubscribe();
         if (timer) clearTimeout(timer);
      };
   }, [status, workflowId, hydrateWorkflowRuns]);

   const selected = selectedId && runs.some((run) => run.id === selectedId) ? selectedId : '';

   return (
      <section className="flex h-full w-full flex-col" aria-label="Run history">
         {selected && (
            <div className="border-b bg-muted/20 px-6 py-5 sm:px-8">
               <WorkflowRunDetail runId={selected} compact />
            </div>
         )}
         <div className="min-h-0 flex-1 overflow-auto">
            {error ? (
               <p className="px-6 py-10 text-muted-foreground sm:px-8" role="alert">
                  {error}
               </p>
            ) : (
               <WorkflowRunsTable
                  runs={runs}
                  selectedId={selected}
                  onSelect={(runId) => select(runId === selected ? null : runId)}
                  emptyText={loaded ? 'This workflow has not run yet.' : 'Loading runs…'}
               />
            )}
         </div>
      </section>
   );
}
