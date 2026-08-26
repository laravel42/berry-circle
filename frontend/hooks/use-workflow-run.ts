'use client';

import { payloadEntityId, subscribeWorkspaceEvents } from '@/lib/events';
import {
   describeWorkflowRunFailure,
   getWorkflowRun,
   isTerminalWorkflowRunStatus,
   type WorkflowRun,
} from '@/lib/workflow-runs';
import { useSessionStore } from '@/store/session-store';
import { useWorkflowRunsStore } from '@/store/workflow-runs-store';
import { useEffect, useState } from 'react';

interface WorkflowRunView {
   run: WorkflowRun | undefined;
   error: string | null;
   loading: boolean;
}

/**
 * One workflow run with its steps, re-read on every run or step event the
 * workspace stream carries for it until the run settles.
 */
export function useWorkflowRun(runId: string): WorkflowRunView {
   const status = useSessionStore((state) => state.status);
   const run = useWorkflowRunsStore((state) => state.runs[runId]);
   const upsertRun = useWorkflowRunsStore((state) => state.upsertRun);
   const [error, setError] = useState<string | null>(null);
   const [loading, setLoading] = useState(false);
   const settled = run ? isTerminalWorkflowRunStatus(run.status) && run.steps !== undefined : false;

   useEffect(() => {
      if (status !== 'ready' || !runId) return;
      const controller = new AbortController();
      const read = (quiet: boolean) => {
         if (!quiet) setLoading(true);
         void getWorkflowRun(runId, controller.signal)
            .then((fetched) => {
               upsertRun(fetched);
               setError(null);
            })
            .catch((failure: unknown) => {
               if (controller.signal.aborted) return;
               if (!quiet) setError(describeWorkflowRunFailure(failure));
            })
            .finally(() => {
               if (!controller.signal.aborted && !quiet) setLoading(false);
            });
      };
      read(false);
      return () => controller.abort();
   }, [status, runId, upsertRun]);

   useEffect(() => {
      if (status !== 'ready' || !runId || settled) return;
      const controller = new AbortController();
      const unsubscribe = subscribeWorkspaceEvents((event) => {
         if (!event.type.startsWith('workflow.run.') && !event.type.startsWith('workflow.step.')) {
            return;
         }
         const id = event.workflowRunId ?? payloadEntityId(event, 'run');
         if (id !== runId) return;
         void getWorkflowRun(runId, controller.signal)
            .then((fetched) => upsertRun(fetched))
            .catch(() => undefined);
      });
      return () => {
         unsubscribe();
         controller.abort();
      };
   }, [status, runId, settled, upsertRun]);

   return { run, error, loading: loading && !run };
}
