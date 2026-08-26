'use client';

import { Button } from '@/components/ui/button';
import {
   DropdownMenu,
   DropdownMenuCheckboxItem,
   DropdownMenuContent,
   DropdownMenuLabel,
   DropdownMenuSeparator,
   DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { describeTriggerType } from '@/lib/workflow-runs';
import { describeWorkflowStatus } from '@/lib/workflows';
import { useWorkflowsFilterStore, type WorkflowsSort } from '@/store/workflows-filter-store';
import { ArrowDown, SlidersHorizontal } from 'lucide-react';

const STATUSES = ['draft', 'active', 'paused'];
const TRIGGERS = ['manual', 'berry_event', 'webhook', 'schedule', 'integration'];
const SORT_LABEL: Record<WorkflowsSort, string> = {
   'updated-desc': 'Last edited',
   'name-asc': 'Name',
   'runs-desc': 'Most runs',
};
const SORT_ORDER: WorkflowsSort[] = ['updated-desc', 'name-asc', 'runs-desc'];

export default function HeaderOptions() {
   const {
      query,
      setQuery,
      status,
      triggerType,
      toggleStatus,
      toggleTriggerType,
      sort,
      setSort,
      activeFilterCount,
   } = useWorkflowsFilterStore();

   return (
      <div className="flex h-10 w-full items-center justify-between gap-3 border-b px-6 py-1.5">
         <div className="flex min-w-0 flex-1 items-center gap-3">
            <Input
               value={query}
               onChange={(event) => setQuery(event.target.value)}
               placeholder="Search workflows…"
               className="h-7 max-w-xs border-none bg-transparent px-0 text-foreground shadow-none placeholder:text-foreground/40"
               aria-label="Search workflows"
            />
         </div>
         <div className="flex shrink-0 items-center gap-2">
            <DropdownMenu>
               <DropdownMenuTrigger asChild>
                  <Button size="xs" variant="secondary" className="relative">
                     <SlidersHorizontal className="mr-1 size-4" />
                     Filter
                     {activeFilterCount > 0 && (
                        <span className="ml-1 rounded bg-accent px-1 tabular-nums">
                           {activeFilterCount}
                        </span>
                     )}
                  </Button>
               </DropdownMenuTrigger>
               <DropdownMenuContent align="end" className="min-w-48">
                  <DropdownMenuLabel>Status</DropdownMenuLabel>
                  {STATUSES.map((entry) => (
                     <DropdownMenuCheckboxItem
                        key={entry}
                        checked={status.includes(entry)}
                        onCheckedChange={() => toggleStatus(entry)}
                     >
                        {describeWorkflowStatus(entry)}
                     </DropdownMenuCheckboxItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>Trigger</DropdownMenuLabel>
                  {TRIGGERS.map((entry) => (
                     <DropdownMenuCheckboxItem
                        key={entry}
                        checked={triggerType.includes(entry)}
                        onCheckedChange={() => toggleTriggerType(entry)}
                     >
                        {describeTriggerType(entry)}
                     </DropdownMenuCheckboxItem>
                  ))}
               </DropdownMenuContent>
            </DropdownMenu>
            <Button
               size="xs"
               variant="secondary"
               onClick={() =>
                  setSort(SORT_ORDER[(SORT_ORDER.indexOf(sort) + 1) % SORT_ORDER.length])
               }
            >
               {SORT_LABEL[sort]}
               <ArrowDown className="ml-1 size-4" />
            </Button>
         </div>
      </div>
   );
}
