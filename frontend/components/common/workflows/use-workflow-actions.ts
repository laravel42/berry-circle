'use client';

import {
   activateWorkflow,
   archiveWorkflow,
   describeWorkflowFailure,
   pauseWorkflow,
   rotateWorkflowWebhook,
   runWorkflow,
   type WebhookSecret,
   type Workflow,
} from '@/lib/workflows';
import type { WorkflowRun } from '@/lib/workflow-runs';
import { useWorkflowRunsStore } from '@/store/workflow-runs-store';
import { useWorkflowsStore, type WorkflowBusyStage } from '@/store/workflows-store';
import { useCallback } from 'react';
import { toast } from 'sonner';

interface WorkflowActions {
   busy: WorkflowBusyStage | null;
   activate: () => Promise<Workflow | undefined>;
   pause: () => Promise<Workflow | undefined>;
   /** Run now; resolves with the pending run, already in the runs store. */
   runNow: (input?: unknown) => Promise<WorkflowRun | undefined>;
   archive: () => Promise<boolean>;
   rotateWebhook: () => Promise<WebhookSecret | undefined>;
}

/**
 * The verbs a workflow header and overview share. Each one reports its
 * outcome in words through a toast and puts the server's record in the
 * store, so every surface showing the workflow agrees on what just happened.
 */
export function useWorkflowActions(workflowId: string): WorkflowActions {
   const busy = useWorkflowsStore((state) => state.busy[workflowId] ?? null);
   const setBusy = useWorkflowsStore((state) => state.setBusy);
   const upsertWorkflow = useWorkflowsStore((state) => state.upsertWorkflow);
   const removeWorkflow = useWorkflowsStore((state) => state.removeWorkflow);
   const upsertRun = useWorkflowRunsStore((state) => state.upsertRun);

   const activate = useCallback(async () => {
      setBusy(workflowId, 'activating');
      try {
         const updated = await activateWorkflow(workflowId);
         upsertWorkflow(updated);
         toast.success('Workflow activated');
         return updated;
      } catch (error) {
         toast.error(describeWorkflowFailure(error));
         return undefined;
      } finally {
         setBusy(workflowId, null);
      }
   }, [workflowId, setBusy, upsertWorkflow]);

   const pause = useCallback(async () => {
      setBusy(workflowId, 'pausing');
      try {
         const updated = await pauseWorkflow(workflowId);
         upsertWorkflow(updated);
         toast.success('Workflow paused');
         return updated;
      } catch (error) {
         toast.error(describeWorkflowFailure(error));
         return undefined;
      } finally {
         setBusy(workflowId, null);
      }
   }, [workflowId, setBusy, upsertWorkflow]);

   const runNow = useCallback(
      async (input?: unknown) => {
         setBusy(workflowId, 'running');
         try {
            const run = await runWorkflow(workflowId, input);
            upsertRun(run);
            toast.success('Run started');
            return run;
         } catch (error) {
            toast.error(describeWorkflowFailure(error));
            return undefined;
         } finally {
            setBusy(workflowId, null);
         }
      },
      [workflowId, setBusy, upsertRun]
   );

   const archive = useCallback(async () => {
      setBusy(workflowId, 'archiving');
      try {
         await archiveWorkflow(workflowId);
         removeWorkflow(workflowId);
         toast.success('Workflow archived');
         return true;
      } catch (error) {
         toast.error(describeWorkflowFailure(error));
         return false;
      } finally {
         setBusy(workflowId, null);
      }
   }, [workflowId, setBusy, removeWorkflow]);

   const rotateWebhook = useCallback(async () => {
      setBusy(workflowId, 'rotating');
      try {
         return await rotateWorkflowWebhook(workflowId);
      } catch (error) {
         toast.error(describeWorkflowFailure(error));
         return undefined;
      } finally {
         setBusy(workflowId, null);
      }
   }, [workflowId, setBusy]);

   return { busy, activate, pause, runNow, archive, rotateWebhook };
}
