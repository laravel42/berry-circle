'use client';

import { Button } from '@/components/ui/button';
import { useCreatePlanStore } from '@/store/create-plan-store';
import { Sparkles } from 'lucide-react';

/**
 * Opens the plan prompt, carrying the project when there is one.
 *
 * Planning is how work starts — it is what produces a goal and the tasks under
 * it — so the action belongs wherever a project does, not only on the goals
 * list. One component so it reads the same in all of them.
 */
export function PlanSomethingButton({
   projectId,
   variant = 'secondary',
   size = 'xs',
}: {
   /** Pre-selects the project being planned in; omitted on a list. */
   projectId?: string;
   variant?: 'secondary' | 'ghost';
   size?: 'xs' | 'sm';
}) {
   const openModal = useCreatePlanStore((state) => state.openModal);
   return (
      <Button
         size={size}
         variant={variant}
         onClick={() => openModal(projectId ? { projectId } : undefined)}
      >
         <Sparkles className="size-4" />
         <span className="hidden sm:inline">Plan something</span>
      </Button>
   );
}
