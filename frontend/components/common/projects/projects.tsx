'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Project } from '@/data/projects';
import { pinTarget } from '@/lib/pins';
import { useIssuesStore } from '@/store/issues-store';
import { usePinsStore } from '@/store/pins-store';
import { useProjectsStore } from '@/store/projects-store';
import { useProjectsFilterStore } from '@/store/projects-filter-store';
import { useProjectsDisplayStore } from '@/store/projects-display-store';
import { useRightPanelStore } from '@/store/right-panel-store';
import { useSessionStore } from '@/store/session-store';
import { BarChart3, Box } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Filter } from '@/components/layout/headers/projects/filter';
import ProjectsBoard, { type ProjectBoardEntry } from './projects-board';
import { CreateProjectDialog } from './create-project-dialog';
import { ProjectsDisplayOptions } from './projects-display-options';
import ProjectsInsightsPanel from './projects-insights-panel';
import ProjectsList from './projects-list';
import { projectCreateStatusOptions } from './create-project/project-status-options';
import ProjectsTimeline from './projects-timeline';

export interface ProjectGroup {
   id: string;
   name: string;
   icon?: string;
   projects: Project[];
}

/** Categories hidden by "Show closed projects: Hide closed". */
const CLOSED_CATEGORIES = new Set(['completed', 'canceled']);

const STATUS_SORT_ORDER: Record<string, number> = {
   'to-do': 0,
   'in-progress': 1,
   'paused': 2,
   'done': 3,
   'cancelled': 4,
};

function sortProjects(list: Project[], sort: string, ordering: string): Project[] {
   const compare = (a: Project, b: Project) => {
      switch (sort) {
         case 'title-desc':
            return b.name.localeCompare(a.name);
         case 'date-asc':
            return (a.targetDate ?? '').localeCompare(b.targetDate ?? '');
         case 'date-desc':
            return (b.targetDate ?? '').localeCompare(a.targetDate ?? '');
         case 'status-asc':
            return (STATUS_SORT_ORDER[a.status.id] ?? 99) - (STATUS_SORT_ORDER[b.status.id] ?? 99);
         case 'status-desc':
            return (STATUS_SORT_ORDER[b.status.id] ?? 99) - (STATUS_SORT_ORDER[a.status.id] ?? 99);
         case 'title-asc':
            return a.name.localeCompare(b.name);
         default:
            break;
      }
      switch (ordering) {
         case 'title':
            return a.name.localeCompare(b.name);
         case 'target-date':
            return (a.targetDate ?? '').localeCompare(b.targetDate ?? '');
         case 'start-date':
         default:
            return a.startDate.localeCompare(b.startDate);
      }
   };
   return list.slice().sort(compare);
}

function applyClosedFilter(list: Project[], closedProjects: string): Project[] {
   if (closedProjects !== 'hide') return list.slice();
   return list.filter((project) => !CLOSED_CATEGORIES.has(project.status.category));
}

function applyDisplayFilters(
   list: Project[],
   filters: { health: string[]; priority: string[]; status: string[]; lead: string[] },
   query: string
): Project[] {
   let filtered = list.slice();
   if (filters.health.length > 0) {
      const healthSet = new Set(filters.health);
      filtered = filtered.filter((project) => healthSet.has(project.health.id));
   }
   if (filters.priority.length > 0) {
      const prioritySet = new Set(filters.priority);
      filtered = filtered.filter((project) => prioritySet.has(project.priority.id));
   }
   if (filters.status.length > 0) {
      const statusSet = new Set(filters.status);
      filtered = filtered.filter((project) => statusSet.has(project.status.id));
   }
   if (filters.lead.length > 0) {
      const leadSet = new Set(filters.lead);
      filtered = filtered.filter((project) => leadSet.has(project.lead.id));
   }
   const term = query.trim().toLowerCase();
   if (term) {
      filtered = filtered.filter((project) => project.name.toLowerCase().includes(term));
   }
   return filtered;
}

function percentCompleteForProject(
   issues: ReturnType<typeof useIssuesStore.getState>['issues'],
   projectId: string
): number {
   const linked = issues.filter((issue) => issue.project?.id === projectId);
   if (linked.length === 0) return 0;
   const done = linked.filter((issue) => issue.status.category === 'completed').length;
   return Math.round((done / linked.length) * 100);
}

/** Projects page: search, filters, display options, views and insights. */
export default function Projects() {
   const t = useTranslations('projects');
   const lists = useTranslations('issueLists');
   const { filters, sort, query, setQuery } = useProjectsFilterStore();
   const { viewType, grouping, ordering, closedProjects, showEmptyGroups } =
      useProjectsDisplayStore();
   const { openPanel, togglePanel } = useRightPanelStore();
   const allProjects = useProjectsStore((state) => state.projects);
   const issues = useIssuesStore((state) => state.issues);
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? '');
   const { pins, add: addPin } = usePinsStore();
   const [selected, setSelected] = useState<string[]>([]);

   const enriched = useMemo(
      () =>
         allProjects.map((project) => ({
            ...project,
            percentComplete: percentCompleteForProject(issues, project.id),
         })),
      [allProjects, issues]
   );

   const scoped = useMemo(
      () => applyClosedFilter(enriched, closedProjects),
      [enriched, closedProjects]
   );

   const displayed = useMemo(
      () => sortProjects(applyDisplayFilters(scoped, filters, query), sort, ordering),
      [scoped, filters, query, sort, ordering]
   );

   const boardEntries = useMemo<ProjectBoardEntry[]>(() => {
      if (grouping === 'none') {
         return [
            {
               group: {
                  id: 'all',
                  name: 'All projects',
                  color: '#8f9299',
                  icon: <Box className="size-4 text-muted-foreground" />,
               },
               projects: displayed,
               total: scoped.length,
            },
         ];
      }

      return projectCreateStatusOptions.map((option) => ({
         group: {
            id: option.status.id,
            name: option.label,
            color: option.status.color,
            icon: <option.status.icon />,
            status: option.status,
         },
         projects: displayed.filter((project) => project.status.id === option.status.id),
         total: scoped.filter((project) => project.status.id === option.status.id).length,
      }));
   }, [displayed, grouping, scoped]);

   const groups = useMemo<ProjectGroup[]>(() => {
      if (grouping === 'none') {
         return [{ id: 'all', name: 'All projects', projects: displayed }];
      }

      return projectCreateStatusOptions
         .map((option) => ({
            id: option.status.id,
            name: option.label,
            projects: displayed.filter((project) => project.status.id === option.status.id),
         }))
         .filter((group) => showEmptyGroups || group.projects.length > 0);
   }, [displayed, grouping, showEmptyGroups]);

   const toggleSelected = (projectId: string) =>
      setSelected((previous) =>
         previous.includes(projectId)
            ? previous.filter((entry) => entry !== projectId)
            : [...previous, projectId]
      );

   /* Pinning a selection is the one bulk action a project list needs: it is
      how a team puts this quarter's work in the rail in one go. */
   const pinSelected = () => {
      const pending = selected.filter(
         (projectId) =>
            !pins.some((pin) => pin.targetType === 'project' && pin.targetId === projectId)
      );
      void Promise.all(pending.map((projectId) => pinTarget(workspaceId, 'project', projectId)))
         .then((created) => {
            for (const pin of created) addPin(pin);
            setSelected([]);
         })
         .catch(() => toast.error('Those projects could not be pinned.'));
   };

   return (
      <div className="w-full h-full flex flex-col overflow-hidden">
         <CreateProjectDialog />
         <div className="w-full flex items-center gap-2 border-b py-1.5 px-6 h-10 shrink-0">
            <Input
               className="h-7 max-w-64"
               placeholder={lists('projects.search')}
               value={query}
               onChange={(event) => setQuery(event.target.value)}
            />
            <div className="ml-auto flex items-center gap-1">
               <Filter />
               <ProjectsDisplayOptions />
               <Button
                  size="xs"
                  variant={openPanel === 'insights' ? 'secondary' : 'ghost'}
                  onClick={() => togglePanel('insights')}
                  aria-label={t('toggleInsights')}
               >
                  <BarChart3 className="size-4" />
               </Button>
            </div>
         </div>

         {selected.length > 0 && (
            <div className="flex items-center gap-2 border-b bg-accent/40 px-6 py-1.5 shrink-0">
               <span>{lists('projects.selected', { count: selected.length })}</span>
               <Button size="xs" variant="secondary" onClick={pinSelected}>
                  {lists('projects.bulkPin')}
               </Button>
               <Button
                  size="xs"
                  variant="ghost"
                  className="ml-auto"
                  onClick={() => setSelected([])}
               >
                  {lists('selection.clear')}
               </Button>
            </div>
         )}

         <div className="flex-1 min-h-0 w-full flex overflow-hidden">
            <div className="flex-1 min-w-0 h-full overflow-hidden">
               {viewType === 'board' ? (
                  <ProjectsBoard
                     entries={boardEntries}
                     totalCount={scoped.length}
                     filteredCount={displayed.length}
                     showEmptyGroups={showEmptyGroups}
                  />
               ) : displayed.length === 0 ? (
                  <div className="flex h-full items-center justify-center text-muted-foreground">
                     {lists('projects.noneMatch')}
                  </div>
               ) : (
                  <>
                     {viewType === 'timeline' && <ProjectsTimeline groups={groups} />}
                     {viewType === 'list' && (
                        <ProjectsList
                           groups={groups}
                           selected={selected}
                           onToggleSelected={toggleSelected}
                        />
                     )}
                  </>
               )}
            </div>

            {openPanel === 'insights' && (
               <aside className="hidden lg:flex w-[360px] shrink-0 border-l h-full overflow-hidden bg-container">
                  <ProjectsInsightsPanel projects={displayed} />
               </aside>
            )}
         </div>
      </div>
   );
}
