'use client';

import {
   Select,
   SelectContent,
   SelectItem,
   SelectTrigger,
   SelectValue,
} from '@/components/ui/select';
import { describeRunStatus } from '@/lib/workflow-runs';
import { useWorkflowRunsFilterStore } from '@/store/workflow-runs-filter-store';

const STATUSES = ['pending', 'running', 'waiting', 'succeeded', 'failed', 'cancelled'];
const ALL = '__all__';

export default function Header() {
   const { status, setStatus } = useWorkflowRunsFilterStore();
   return (
      <header className="flex h-auto w-full flex-col gap-2 border-b px-6 py-3">
         <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
               <span className="font-medium">Runs</span>
               <p className="mt-1 max-w-2xl text-muted-foreground">
                  Every workflow run in the workspace — what started it, the outcome of each step,
                  and the ledger as it was written. Runs are records, not tasks.
               </p>
            </div>
            <Select
               value={status || ALL}
               onValueChange={(value) => setStatus(value === ALL ? '' : value)}
            >
               <SelectTrigger className="h-7 w-36" aria-label="Filter by status">
                  <SelectValue placeholder="Any status" />
               </SelectTrigger>
               <SelectContent>
                  <SelectItem value={ALL}>Any status</SelectItem>
                  {STATUSES.map((entry) => (
                     <SelectItem key={entry} value={entry}>
                        {describeRunStatus(entry)}
                     </SelectItem>
                  ))}
               </SelectContent>
            </Select>
         </div>
      </header>
   );
}
