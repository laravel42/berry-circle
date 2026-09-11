'use client';

import { BatchToolbar } from '@/components/common/issues/batch-toolbar';
import { GroupedIssuesView } from '@/components/common/issues/grouped-issues-view';
import { InsightsPanel } from '@/components/common/issues/insights-panel';
import { IssueFilterBar } from '@/components/common/issues/issue-filter-bar';
import {
   applyIssueFilters,
   usePropertyFilterMatches,
} from '@/components/common/issues/issue-filter-columns';
import { IssueGantt } from '@/components/common/issues/issue-gantt';
import { IssueSwimlanes } from '@/components/common/issues/issue-swimlanes';
import { IssueTable } from '@/components/common/issues/issue-table';
import { QuickCreate } from '@/components/common/issues/quick-create';
import { SearchIssues } from '@/components/common/issues/search-issues';
import { useIssueListView } from '@/components/common/issues/use-issue-list-view';
import { BreakdownPanel } from './breakdown-panel';
import { displayOrderedStatus } from '@/data/status';
import { useFilterStore } from '@/store/filter-store';
import { useIssuesStore } from '@/store/issues-store';
import { useRightPanelStore } from '@/store/right-panel-store';
import { useSearchStore } from '@/store/search-store';
import { useMemo } from 'react';
import { scopeMyIssues, useMyIssuesScope, useMyIssuesTab } from './use-my-issues';

/**
 * "My issues" body — the same machinery as the team views (search, filters,
 * every layout, insights), scoped to the tab: everything, what this person is
 * holding, what they opened, or what their agents and squads are on.
 */
export default function MyIssues() {
   const [tab] = useMyIssuesTab();
   const scope = useMyIssuesScope();
   const { isSearchOpen, searchQuery } = useSearchStore();
   const view = useIssueListView();
   const { filters } = useFilterStore();
   const { issues } = useIssuesStore();
   const { openPanel } = useRightPanelStore();

   const isSearching = isSearchOpen && searchQuery.trim() !== '';

   const scopedIssues = useMemo(() => scopeMyIssues(issues, tab, scope), [issues, tab, scope]);

   const propertyMatches = usePropertyFilterMatches(filters);

   const displayedIssues = useMemo(
      () => applyIssueFilters(scopedIssues, filters, propertyMatches),
      [scopedIssues, filters, propertyMatches]
   );

   if (isSearching) {
      return (
         <div className="w-full h-full">
            <div className="px-6 mb-6">
               <SearchIssues />
            </div>
         </div>
      );
   }

   return (
      <div className="w-full h-full flex flex-col overflow-hidden">
         <IssueFilterBar />
         <QuickCreate />
         <BatchToolbar visibleIds={displayedIssues.map((issue) => issue.id)} />
         <div className="flex-1 min-h-0 w-full flex overflow-hidden">
            <div className="flex-1 min-w-0 h-full overflow-hidden">
               {view.mode === 'table' ? (
                  <IssueTable
                     issues={displayedIssues}
                     statuses={displayOrderedStatus}
                     totalIssues={scopedIssues}
                  />
               ) : view.mode === 'swimlane' ? (
                  <IssueSwimlanes issues={displayedIssues} statuses={displayOrderedStatus} />
               ) : view.mode === 'gantt' ? (
                  <IssueGantt issues={displayedIssues} />
               ) : (
                  <GroupedIssuesView
                     issues={displayedIssues}
                     totalIssues={scopedIssues}
                     statuses={displayOrderedStatus}
                     isViewTypeGrid={view.mode === 'grid'}
                  />
               )}
            </div>

            {openPanel === 'insights' && (
               <aside className="hidden lg:flex w-[420px] shrink-0 border-l h-full overflow-hidden bg-container">
                  <InsightsPanel issues={displayedIssues} />
               </aside>
            )}
            {openPanel === 'breakdown' && (
               <aside className="hidden lg:flex w-80 shrink-0 border-l h-full overflow-hidden bg-container">
                  <BreakdownPanel issues={displayedIssues} />
               </aside>
            )}
         </div>
      </div>
   );
}
