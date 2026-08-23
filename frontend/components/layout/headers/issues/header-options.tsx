'use client';

import { IssueFilterTrigger } from '@/components/common/issues/issue-filter-trigger';
import { Button } from '@/components/ui/button';
import { useFilterStore } from '@/store/filter-store';
import { useIssuesStore } from '@/store/issues-store';
import { useRightPanelStore } from '@/store/right-panel-store';
import { BarChart3 } from 'lucide-react';
import { DisplayOptions } from '../display-options';

export default function HeaderOptions() {
   const { openPanel, togglePanel } = useRightPanelStore();
   const { issues } = useIssuesStore();
   const { hasActiveFilters } = useFilterStore();

   if (issues.length === 0 && !hasActiveFilters()) {
      return null;
   }

   return (
      <div className="w-full flex justify-between items-center border-b py-1.5 px-6 h-10">
         <div />
         <div className="flex items-center gap-1">
            <IssueFilterTrigger />
            <Button
               size="xs"
               variant={openPanel === 'insights' ? 'secondary' : 'ghost'}
               onClick={() => togglePanel('insights')}
               aria-label="Toggle insights panel"
            >
               <BarChart3 className="size-4" />
            </Button>
            <DisplayOptions />
         </div>
      </div>
   );
}
