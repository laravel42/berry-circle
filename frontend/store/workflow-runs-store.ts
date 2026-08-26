import type { WorkflowRun } from '@/lib/workflow-runs';
import { create } from 'zustand';

interface WorkflowRunsState {
   /** Every run this tab has seen, by id. */
   runs: Record<string, WorkflowRun>;
   /** Run ids newest first, per workflow, for a workflow's history. */
   runsByWorkflowId: Record<string, string[]>;
   /** Run ids newest first for the workspace ledger. */
   workspaceRunIds: string[];
   error: string | null;
   loaded: boolean;
   hydrateWorkspaceRuns: (runs: WorkflowRun[], error?: string | null) => void;
   hydrateWorkflowRuns: (workflowId: string, runs: WorkflowRun[]) => void;
   /** A single read carries steps; a list row does not, and must not erase them. */
   upsertRun: (run: WorkflowRun) => void;
   getRun: (runId: string) => WorkflowRun | undefined;
   runsFor: (workflowId: string) => WorkflowRun[];
}

function merge(existing: WorkflowRun | undefined, incoming: WorkflowRun): WorkflowRun {
   if (!existing) return incoming;
   if (incoming.steps === undefined && existing.steps !== undefined) {
      return { ...incoming, steps: existing.steps };
   }
   return incoming;
}

function sortedIds(runs: Record<string, WorkflowRun>, ids: Iterable<string>): string[] {
   return Array.from(new Set(ids))
      .filter((id) => runs[id])
      .sort((left, right) => runs[right].createdAt.localeCompare(runs[left].createdAt));
}

export const useWorkflowRunsStore = create<WorkflowRunsState>((set, get) => ({
   runs: {},
   runsByWorkflowId: {},
   workspaceRunIds: [],
   error: null,
   loaded: false,

   hydrateWorkspaceRuns: (incoming, error = null) =>
      set((state) => {
         const runs = { ...state.runs };
         for (const run of incoming) runs[run.id] = merge(runs[run.id], run);
         const byWorkflow: Record<string, string[]> = { ...state.runsByWorkflowId };
         for (const run of incoming) {
            byWorkflow[run.workflowId] = sortedIds(runs, [
               ...(byWorkflow[run.workflowId] ?? []),
               run.id,
            ]);
         }
         return {
            runs,
            runsByWorkflowId: byWorkflow,
            workspaceRunIds: sortedIds(
               runs,
               incoming.map((run) => run.id)
            ),
            error,
            loaded: true,
         };
      }),

   hydrateWorkflowRuns: (workflowId, incoming) =>
      set((state) => {
         const runs = { ...state.runs };
         for (const run of incoming) runs[run.id] = merge(runs[run.id], run);
         return {
            runs,
            runsByWorkflowId: {
               ...state.runsByWorkflowId,
               [workflowId]: sortedIds(
                  runs,
                  incoming.map((run) => run.id)
               ),
            },
         };
      }),

   upsertRun: (run) =>
      set((state) => {
         const runs = { ...state.runs, [run.id]: merge(state.runs[run.id], run) };
         const forWorkflow = state.runsByWorkflowId[run.workflowId] ?? [];
         return {
            runs,
            runsByWorkflowId: {
               ...state.runsByWorkflowId,
               [run.workflowId]: sortedIds(runs, [...forWorkflow, run.id]),
            },
            workspaceRunIds: state.loaded
               ? sortedIds(runs, [...state.workspaceRunIds, run.id])
               : state.workspaceRunIds,
         };
      }),

   getRun: (runId) => get().runs[runId],
   runsFor: (workflowId) => {
      const state = get();
      return (state.runsByWorkflowId[workflowId] ?? [])
         .map((id) => state.runs[id])
         .filter((run): run is WorkflowRun => Boolean(run));
   },
}));
