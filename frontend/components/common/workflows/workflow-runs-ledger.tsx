'use client';

import { Button } from '@/components/ui/button';
import { useWorkflowRunsFilterStore } from '@/store/workflow-runs-filter-store';
import { useWorkflowRunsStore } from '@/store/workflow-runs-store';
import { useMemo } from 'react';
import { WorkflowRunsTable } from './workflow-history';
import { WorkflowRunDetail } from './workflow-run-detail';

/**
 * Every workflow run in the workspace, newest first, kept live by the
 * workspace stream. Mirrors the runtimes ledger for agent runs: a run is
 * an execution record, never a task.
 */
export default function WorkflowRunsLedger() {
   const runs = useWorkflowRunsStore((state) => state.runs);
   const workspaceRunIds = useWorkflowRunsStore((state) => state.workspaceRunIds);
   const loaded = useWorkflowRunsStore((state) => state.loaded);
   const error = useWorkflowRunsStore((state) => state.error);
   const { status, workflowId, selectedId, select, setStatus, setWorkflowId } =
      useWorkflowRunsFilterStore();

   const visible = useMemo(() => {
      return workspaceRunIds
         .map((id) => runs[id])
         .filter((run) => Boolean(run))
         .filter((run) => !status || run.status === status)
         .filter((run) => !workflowId || run.workflowId === workflowId);
   }, [workspaceRunIds, runs, status, workflowId]);

   const selected = selectedId && runs[selectedId] ? selectedId : '';

   return (
      <section className="flex h-full w-full flex-col" aria-label="Workflow runs">
         {selected && (
            <div className="border-b bg-muted/20 px-6 py-5 sm:px-8">
               <WorkflowRunDetail runId={selected} compact />
            </div>
         )}
         {(status || workflowId) && (
            <div className="flex items-center gap-2 border-b px-6 py-1.5 text-muted-foreground sm:px-8">
               <span>
                  Showing {visible.length} of {workspaceRunIds.length}
               </span>
               <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => {
                     setStatus('');
                     setWorkflowId('');
                  }}
               >
                  Clear filters
               </Button>
            </div>
         )}
         <div className="min-h-0 flex-1 overflow-auto">
            {error ? (
               <p className="px-6 py-10 text-muted-foreground sm:px-8" role="alert">
                  {error}
               </p>
            ) : (
               <WorkflowRunsTable
                  runs={visible}
                  selectedId={selected}
                  onSelect={(runId) => select(runId === selected ? null : runId)}
                  showWorkflow
                  emptyText={
                     loaded
                        ? status || workflowId
                           ? 'No runs match.'
                           : 'No workflow has run yet.'
                        : 'Loading runs…'
                  }
               />
            )}
         </div>
      </section>
   );
}
