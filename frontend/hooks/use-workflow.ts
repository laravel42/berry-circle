'use client';

import { describeWorkflowFailure, getWorkflow, type Workflow } from '@/lib/workflows';
import { payloadEntityId, subscribeWorkspaceEvents } from '@/lib/events';
import { useSessionStore } from '@/store/session-store';
import { useWorkflowsStore } from '@/store/workflows-store';
import { useEffect, useState } from 'react';

interface WorkflowView {
   workflow: Workflow | undefined;
   error: string | null;
   loading: boolean;
}

/**
 * One workflow from the store, read from the API when the list has not
 * seen it, and re-read whenever the workspace stream says it changed.
 */
export function useWorkflow(workflowId: string): WorkflowView {
   const status = useSessionStore((state) => state.status);
   const workflow = useWorkflowsStore((state) =>
      state.workflows.find((candidate) => candidate.id === workflowId)
   );
   const upsertWorkflow = useWorkflowsStore((state) => state.upsertWorkflow);
   const [error, setError] = useState<string | null>(null);
   const [loading, setLoading] = useState(false);

   useEffect(() => {
      if (status !== 'ready' || !workflowId) return;
      const controller = new AbortController();
      const read = (quiet: boolean) => {
         if (!quiet) setLoading(true);
         void getWorkflow(workflowId, controller.signal)
            .then((fetched) => {
               upsertWorkflow(fetched);
               setError(null);
            })
            .catch((failure: unknown) => {
               if (controller.signal.aborted) return;
               if (!quiet) setError(describeWorkflowFailure(failure));
            })
            .finally(() => {
               if (!controller.signal.aborted && !quiet) setLoading(false);
            });
      };
      // The list omits nothing a detail needs, but a fresh read is cheap and
      // catches a revision bumped in another tab.
      read(false);
      const unsubscribe = subscribeWorkspaceEvents((event) => {
         if (!event.type.startsWith('workflow.')) return;
         const id = event.workflowId ?? payloadEntityId(event, 'workflow');
         if (id === workflowId) read(true);
      });
      return () => {
         unsubscribe();
         controller.abort();
      };
   }, [status, workflowId, upsertWorkflow]);

   return { workflow, error, loading: loading && !workflow };
}
