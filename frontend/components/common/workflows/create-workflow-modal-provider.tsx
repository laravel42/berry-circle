'use client';

import { CreateWorkflowDialog } from './create-workflow-dialog';

/** Keeps the New workflow dialog mounted beside the task and plan dialogs. */
export function CreateWorkflowModalProvider() {
   return <CreateWorkflowDialog />;
}
