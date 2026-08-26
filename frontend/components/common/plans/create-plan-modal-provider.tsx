'use client';

import { CreatePlanDialog } from './create-plan-dialog';

/** Keeps the plan prompt mounted beside the task dialog, openable from anywhere. */
export function CreatePlanModalProvider() {
   return <CreatePlanDialog />;
}
