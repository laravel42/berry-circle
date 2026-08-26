import type { Workflow } from '@/lib/workflows';
import { create } from 'zustand';

/** What the store is doing to a workflow right now, for buttons to reflect. */
export type WorkflowBusyStage =
   'loading' | 'saving' | 'activating' | 'pausing' | 'running' | 'archiving' | 'rotating';

interface WorkflowsState {
   workflows: Workflow[];
   error: string | null;
   loaded: boolean;
   busy: Record<string, WorkflowBusyStage | null>;
   hydrateWorkflows: (workflows: Workflow[], error?: string | null) => void;
   upsertWorkflow: (workflow: Workflow) => void;
   removeWorkflow: (workflowId: string) => void;
   setBusy: (workflowId: string, stage: WorkflowBusyStage | null) => void;
   getWorkflowById: (workflowId: string) => Workflow | undefined;
}

function sortWorkflows(workflows: Workflow[]): Workflow[] {
   return workflows.slice().sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export const useWorkflowsStore = create<WorkflowsState>((set, get) => ({
   workflows: [],
   error: null,
   loaded: false,
   busy: {},
   hydrateWorkflows: (workflows, error = null) =>
      set({ workflows: sortWorkflows(workflows), error, loaded: true }),
   upsertWorkflow: (workflow) =>
      set((state) => {
         // A stale read must not undo a newer one; equal timestamps replace.
         const existing = state.workflows.find((candidate) => candidate.id === workflow.id);
         if (existing && existing.revision > workflow.revision) return state;
         const next = state.workflows.filter((candidate) => candidate.id !== workflow.id);
         next.push(workflow);
         return { workflows: sortWorkflows(next), error: null };
      }),
   removeWorkflow: (workflowId) =>
      set((state) => ({
         workflows: state.workflows.filter((workflow) => workflow.id !== workflowId),
      })),
   setBusy: (workflowId, stage) =>
      set((state) => ({ busy: { ...state.busy, [workflowId]: stage } })),
   getWorkflowById: (workflowId) => get().workflows.find((workflow) => workflow.id === workflowId),
}));
