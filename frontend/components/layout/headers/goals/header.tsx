'use client';

import { Button } from '@/components/ui/button';
import { useCreateGoalStore } from '@/store/create-goal-store';
import { useCreatePlanStore } from '@/store/create-plan-store';
import { Plus, Sparkles } from 'lucide-react';

export default function Header() {
   const openCreatePlan = useCreatePlanStore((state) => state.openModal);
   const openCreateGoal = useCreateGoalStore((state) => state.openModal);
   return (
      <header className="flex h-auto w-full flex-col gap-2 border-b px-6 py-3">
         <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
               <span className="font-medium">Goals</span>
               <p className="mt-1 max-w-2xl text-muted-foreground">
                  The outcomes work serves. Each goal counts its tasks and
                  it and the approvals it waits on.
               </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
               <Button size="xs" variant="secondary" onClick={() => openCreatePlan()}>
                  <Sparkles className="size-4" />
                  Plan something
               </Button>
               <Button size="xs" variant="secondary" onClick={() => openCreateGoal()}>
                  <Plus className="size-4" />
                  New goal
               </Button>
            </div>
         </div>
      </header>
   );
}
