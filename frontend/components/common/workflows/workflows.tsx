'use client';

import { BerryMark } from '@/components/brand/berry-mark';
import { Button } from '@/components/ui/button';
import type { Workflow } from '@/lib/workflows';
import { useCreatePlanStore } from '@/store/create-plan-store';
import { useCreateWorkflowStore } from '@/store/create-workflow-store';
import { useWorkflowsFilterStore } from '@/store/workflows-filter-store';
import { useWorkflowsStore } from '@/store/workflows-store';
import { useMemo } from 'react';
import WorkflowLine from './workflow-line';

/** Nothing automated yet: the way in is a trigger or a prompt. */
function EmptyWorkflows() {
   const openCreateWorkflow = useCreateWorkflowStore((state) => state.openModal);
   const openCreatePlan = useCreatePlanStore((state) => state.openModal);
   return (
      <div className="flex min-h-64 w-full items-center justify-center px-6 py-12">
         <div className="flex max-w-sm flex-col items-center text-center">
            <BerryMark size="lg" tone="neutral" state="hollow" label="No workflows" />
            <h2 className="mt-5 font-display tracking-[-0.025em]">Nothing automated yet.</h2>
            <p className="mt-2 leading-relaxed text-muted-foreground">
               A workflow starts on a trigger — a Berry event, a webhook, or by hand — and runs
               typed steps: create a task, ask an agent, wait for an approval, call a tool.
            </p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
               <Button className="h-10 px-5" onClick={() => openCreateWorkflow()}>
                  new workflow
               </Button>
               <Button
                  variant="secondary"
                  className="h-10 px-5"
                  onClick={() => openCreatePlan({ hint: 'workflow' })}
               >
                  describe one
               </Button>
            </div>
         </div>
      </div>
   );
}

function sortWorkflows(list: Workflow[], sort: string): Workflow[] {
   const sorted = list.slice();
   switch (sort) {
      case 'name-asc':
         return sorted.sort((left, right) => left.name.localeCompare(right.name));
      case 'runs-desc':
         return sorted.sort((left, right) => right.runCounts.total - left.runCounts.total);
      default:
         return sorted.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
   }
}

export default function Workflows() {
   const workflows = useWorkflowsStore((state) => state.workflows);
   const loaded = useWorkflowsStore((state) => state.loaded);
   const error = useWorkflowsStore((state) => state.error);
   const { status, triggerType, query, sort, activeFilterCount, clearFilters } =
      useWorkflowsFilterStore();

   const displayed = useMemo(() => {
      const needle = query.trim().toLowerCase();
      const filtered = workflows.filter((workflow) => {
         if (status.length > 0 && !status.includes(workflow.status)) return false;
         if (triggerType.length > 0 && !triggerType.includes(workflow.trigger.type)) return false;
         if (
            needle &&
            !workflow.name.toLowerCase().includes(needle) &&
            !(workflow.description ?? '').toLowerCase().includes(needle)
         ) {
            return false;
         }
         return true;
      });
      return sortWorkflows(filtered, sort);
   }, [workflows, status, triggerType, query, sort]);

   return (
      <div className="w-full">
         <div className="sticky top-0 z-10 flex items-center border-b bg-container px-6 py-1.5 text-muted-foreground">
            <div className="min-w-0 flex-1">Workflow</div>
            <div className="w-27.5 shrink-0">Status</div>
            <div className="hidden w-56 shrink-0 lg:block">Trigger</div>
            <div className="hidden w-40 shrink-0 sm:block">Last run</div>
            <div className="w-16 shrink-0 text-right">Runs</div>
         </div>

         {!loaded && !error ? (
            <div className="px-6 py-10 text-muted-foreground">Loading workflows…</div>
         ) : error ? (
            <div className="px-6 py-10 text-muted-foreground" role="alert">
               {error}
            </div>
         ) : workflows.length === 0 ? (
            <EmptyWorkflows />
         ) : displayed.length === 0 ? (
            <div className="px-6 py-10 text-muted-foreground">
               No workflows match.
               {activeFilterCount > 0 && (
                  <Button variant="ghost" size="xs" className="ml-2" onClick={clearFilters}>
                     Clear filters
                  </Button>
               )}
            </div>
         ) : (
            displayed.map((workflow) => <WorkflowLine key={workflow.id} workflow={workflow} />)
         )}
      </div>
   );
}
