'use client';

import { GroupedIssuesView } from '@/components/common/issues/grouped-issues-view';
import { InsightsPanel } from '@/components/common/issues/insights-panel';
import { IssueGantt } from '@/components/common/issues/issue-gantt';
import { IssueSwimlanes } from '@/components/common/issues/issue-swimlanes';
import { IssueTable } from '@/components/common/issues/issue-table';
import { applyIssueFilters } from '@/components/common/issues/issue-filter-columns';
import { useIssueListView } from '@/components/common/issues/use-issue-list-view';
import ProjectsList from '@/components/common/projects/projects-list';
import { ProjectGroup } from '@/components/common/projects/projects';
import type { FiltersState } from '@/components/data-table-filter/core/types';
import { status as allStatus } from '@/data/status';
import { filterIssuesForView, filterProjectsForView, type View } from '@/data/views';
import { WORKSPACE_SLUG } from '@/lib/config';
import { useIssuesStore } from '@/store/issues-store';
import { useProjectsStore } from '@/store/projects-store';
import { useViewsStore } from '@/store/views-store';
import { useRightPanelStore } from '@/store/right-panel-store';
import type { ViewType } from '@/store/view-store';
import { useTranslations } from 'next-intl';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef } from 'react';
import { toast } from 'sonner';
import { ViewFacets } from './view-facets';

/** A view's saved chips, revived into the shape the filter functions take. */
function savedFiltersOf(view: View): FiltersState {
   return view.savedFilters.map((entry) => {
      const filter = entry as { type?: string; values?: unknown[] };
      if (filter.type !== 'date' || !Array.isArray(filter.values)) return entry as never;
      return {
         ...filter,
         values: filter.values.map((value) =>
            value instanceof Date ? value : new Date(String(value))
         ),
      } as never;
   });
}

function IssueViewBody({ view }: { view: View }) {
   const { openPanel } = useRightPanelStore();
   const listView = useIssueListView();
   const allIssues = useIssuesStore((state) => state.issues);

   const issues = useMemo(() => {
      const declarative = filterIssuesForView(view, allIssues);
      const chips = savedFiltersOf(view);
      return chips.length > 0 ? applyIssueFilters(declarative, chips) : declarative;
   }, [view, allIssues]);

   // The view's own layout wins until this reader asks for another one, which
   // the URL carries — so a shared link still opens the way it was saved.
   const savedLayout = view.display.layout;
   const mode: ViewType =
      !listView.isLinked && typeof savedLayout === 'string'
         ? (savedLayout as ViewType)
         : listView.mode;

   return (
      <div className="w-full h-full flex flex-col overflow-hidden">
         <ViewFacets view={view} />
         <div className="flex-1 min-h-0 w-full flex overflow-hidden">
            <div className="flex-1 min-w-0 h-full overflow-hidden">
               {mode === 'table' ? (
                  <IssueTable issues={issues} statuses={allStatus} totalIssues={issues} />
               ) : mode === 'swimlane' ? (
                  <IssueSwimlanes issues={issues} statuses={allStatus} />
               ) : mode === 'gantt' ? (
                  <IssueGantt issues={issues} />
               ) : (
                  <GroupedIssuesView
                     issues={issues}
                     totalIssues={issues}
                     statuses={allStatus}
                     isViewTypeGrid={mode === 'grid'}
                  />
               )}
            </div>
            {openPanel === 'insights' && (
               <aside className="hidden lg:flex w-[420px] shrink-0 border-l h-full overflow-hidden bg-container">
                  <InsightsPanel issues={issues} />
               </aside>
            )}
         </div>
      </div>
   );
}

function ProjectViewBody({ view }: { view: View }) {
   const allProjects = useProjectsStore((state) => state.projects);
   const groups = useMemo<ProjectGroup[]>(() => {
      const projects = filterProjectsForView(view, allProjects);
      const byStatus = new Map<string, ProjectGroup>();
      for (const project of projects) {
         const key = project.status.id;
         if (!byStatus.has(key)) {
            byStatus.set(key, { id: key, name: project.status.name, projects: [] });
         }
         byStatus.get(key)!.projects.push(project);
      }
      return [...byStatus.values()];
   }, [view, allProjects]);

   return <ProjectsList groups={groups} />;
}

/** Saved-view detail page: filtered issues (with insights) or projects. */
export default function ViewDetails({ viewId }: { viewId: string }) {
   const t = useTranslations('issueLists');
   const router = useRouter();
   const { orgId } = useParams<{ orgId?: string }>();
   const view = useViewsStore((state) => state.getViewById(viewId));
   const views = useViewsStore((state) => state.views);
   const announced = useRef(false);

   // A view someone deleted, or one that was never shared with this person,
   // is a dead end: say so once and go back to the list rather than leaving
   // an empty page with a link that will never resolve.
   useEffect(() => {
      if (view || views.length === 0 || announced.current) return;
      announced.current = true;
      toast.info(t('views.missing'));
      router.replace(`/${orgId ?? WORKSPACE_SLUG}/views`);
   }, [view, views.length, router, orgId, t]);

   if (!view) {
      return (
         <div className="w-full h-full flex items-center justify-center text-muted-foreground">
            {t('states.loading')}
         </div>
      );
   }

   return view.type === 'issue' ? <IssueViewBody view={view} /> : <ProjectViewBody view={view} />;
}
