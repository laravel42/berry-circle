'use client';

import { BatchToolbar } from '@/components/common/issues/batch-toolbar';
import { GroupedIssuesView } from '@/components/common/issues/grouped-issues-view';
import {
   applyIssueFilters,
   usePropertyFilterMatches,
} from '@/components/common/issues/issue-filter-columns';
import { IssueFilterBar } from '@/components/common/issues/issue-filter-bar';
import { IssueGantt } from '@/components/common/issues/issue-gantt';
import { IssueSwimlanes } from '@/components/common/issues/issue-swimlanes';
import { IssueTable } from '@/components/common/issues/issue-table';
import { useIssueListView } from '@/components/common/issues/use-issue-list-view';
import { getProjectDetail } from '@/data/project-details';
import { displayOrderedStatus } from '@/data/status';
import { useProject } from '@/hooks/use-project';
import { useFilterStore } from '@/store/filter-store';
import { useIssuesStore } from '@/store/issues-store';
import { useMemo } from 'react';
import { ProjectSidePanel } from './project-side-panel';

interface ProjectIssuesProps {
   projectId: string;
}

/**
 * A project's tasks: the same list machinery as everywhere else — filters,
 * every layout, selection — scoped to this project, beside the project's own
 * panel.
 */
export default function ProjectIssues({ projectId }: ProjectIssuesProps) {
   const project = useProject(projectId);
   const detail = getProjectDetail(projectId);
   const { issues: allIssues } = useIssuesStore();
   const { filters } = useFilterStore();
   const view = useIssueListView();

   const issues = useMemo(
      () => (project ? allIssues.filter((issue) => issue.project?.id === project.id) : []),
      [allIssues, project]
   );

   // Filters (filter bar + click-to-filter from the insights panel) apply
   // on top of the project scope.
   const propertyMatches = usePropertyFilterMatches(filters);
   const displayedIssues = useMemo(
      () => applyIssueFilters(issues, filters, propertyMatches),
      [issues, filters, propertyMatches]
   );

   if (!project) {
      return <div className="p-6 text-muted-foreground">Loading project…</div>;
   }

   return (
      <div className="w-full h-full flex flex-col overflow-hidden">
         <IssueFilterBar />
         <BatchToolbar visibleIds={displayedIssues.map((issue) => issue.id)} />
         <div className="flex-1 min-h-0 w-full flex overflow-hidden">
            <div className="flex-1 min-w-0 h-full overflow-hidden">
               {view.mode === 'table' ? (
                  <IssueTable
                     issues={displayedIssues}
                     statuses={displayOrderedStatus}
                     totalIssues={issues}
                  />
               ) : view.mode === 'swimlane' ? (
                  <IssueSwimlanes issues={displayedIssues} statuses={displayOrderedStatus} />
               ) : view.mode === 'gantt' ? (
                  <IssueGantt issues={displayedIssues} />
               ) : (
                  <GroupedIssuesView
                     issues={displayedIssues}
                     totalIssues={issues}
                     statuses={displayOrderedStatus}
                     isViewTypeGrid={view.mode === 'grid'}
                  />
               )}
            </div>
            <ProjectSidePanel
               project={project}
               detail={detail}
               issues={issues}
               insightsIssues={displayedIssues}
            />
         </div>
      </div>
   );
}
