'use client';

import { CreateGoalDialog } from './create-goal-dialog';

/** Keeps the New goal dialog mounted beside the task and plan dialogs. */
export function CreateGoalModalProvider() {
   return <CreateGoalDialog />;
}
