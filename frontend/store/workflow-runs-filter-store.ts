'use client';

import { parseAsString, useQueryStates } from 'nuqs';

const parsers = {
   status: parseAsString.withDefault(''),
   workflow: parseAsString.withDefault(''),
   run: parseAsString.withDefault(''),
};

export interface WorkflowRunsFilterState {
   status: string;
   workflowId: string;
   /** The run open in the detail pane. */
   selectedId: string;
   setStatus: (status: string) => void;
   setWorkflowId: (workflowId: string) => void;
   select: (runId: string | null) => void;
}

/** Runs ledger state, URL-synced (?status=…&workflow=…&run=…). */
export function useWorkflowRunsFilterStore(): WorkflowRunsFilterState {
   const [state, setState] = useQueryStates(parsers, { history: 'replace' });
   return {
      status: state.status,
      workflowId: state.workflow,
      selectedId: state.run,
      setStatus: (status) => setState({ status: status || null }),
      setWorkflowId: (workflowId) => setState({ workflow: workflowId || null }),
      select: (runId) => setState({ run: runId || null }),
   };
}
