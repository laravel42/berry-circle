'use client';

import { BerryMark } from '@/components/brand/berry-mark';
import { PlanStatusBadge, planLook } from '@/components/common/plans/plan-status-badge';
import { Button } from '@/components/ui/button';
import { useCreatePlanStore } from '@/store/create-plan-store';
import { usePlanStore } from '@/store/plan-store';
import { ChevronRight, Sparkles } from 'lucide-react';

/**
 * Plan page header: crumb (plans › mark + goal title), the plan's state, and
 * the way to ask for another plan. "Plans" is not a link yet — the goals
 * list that will house plans is not built yet.
 */
export default function Header({ planId }: { planId: string }) {
   const record = usePlanStore((state) => state.records[planId]);
   const openCreatePlan = useCreatePlanStore((state) => state.openModal);

   const look = record ? planLook(record) : null;
   const title =
      record?.plan?.goal.title ??
      record?.sourcePrompt?.replace(/\s+/g, ' ').trim() ??
      (record ? 'Plan' : 'Loading plan…');

   return (
      <div className="flex h-10 w-full items-center justify-between gap-4 border-b px-6 py-1.5">
         <div className="flex min-w-0 items-center gap-1.5">
            <span className="text-muted-foreground">Plans</span>
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
            <BerryMark
               size="sm"
               tone={look?.tone ?? 'neutral'}
               state={look?.state ?? 'hollow'}
               pulse={look?.pulse}
            />
            <span className="truncate font-medium">{title}</span>
         </div>
         <div className="flex shrink-0 items-center gap-2">
            {record && <PlanStatusBadge record={record} className="hidden sm:inline-flex" />}
            <Button size="xs" variant="secondary" onClick={() => openCreatePlan()}>
               <Sparkles className="size-4" />
               <span className="hidden sm:inline">New plan</span>
            </Button>
         </div>
      </div>
   );
}
