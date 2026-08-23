'use client';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Project } from '@/data/projects';
import { useTeamsStore } from '@/store/teams-store';
import { useIssuesStore } from '@/store/issues-store';
import { useProjectsStore } from '@/store/projects-store';
import { useProjectsFilterStore } from '@/store/projects-filter-store';
import { useProjectsDisplayStore } from '@/store/projects-display-store';
import { useRightPanelStore } from '@/store/right-panel-store';
import { useSessionStore } from '@/store/session-store';
import { BarChart3, Box } from 'lucide-react';
import { parseAsStringLiteral, useQueryState } from 'nuqs';
import { useMemo } from 'react';
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

const TABS = ['all', 'active'] as const;

const TAB_ITEMS: { label: string; value: (typeof TABS)[number] }[] = [
   { label: 'All projects', value: 'all' },
   { label: 'Active projects', value: 'active' },
];

/** Status categories considered "active" for the Active projects tab. */
const ACTIVE_CATEGORIES = new Set(['backlog', 'unstarted', 'started']);
/** Categories hidden by "Show closed projects: Hide closed". */
const CLOSED_CATEGORIES = new Set(['completed', 'canceled']);

const STATUS_SORT_ORDER: Record<string, number> = {
   'to-do': 0,
   'in-progress': 1,
   paused: 2,
   done: 3,
   cancelled: 4,
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
            return (
               (STATUS_SORT_ORDER[a.status.id] ?? 99) - (STATUS_SORT_ORDER[b.status.id] ?? 99)
            );
         case 'status-desc':
            return (
               (STATUS_SORT_ORDER[b.status.id] ?? 99) - (STATUS_SORT_ORDER[a.status.id] ?? 99)
            );
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

function applyTabScope(list: Project[], teamId: string | undefined, tab: string, closedProjects: string): Project[] {
   let scoped = list.slice();
   if (teamId) {
      scoped = scoped.filter((project) => project.teamId === teamId);
   }
   if (tab === 'active') {
      scoped = scoped.filter((project) => ACTIVE_CATEGORIES.has(project.status.category));
   }
   if (closedProjects === 'hide') {
      scoped = scoped.filter((project) => !CLOSED_CATEGORIES.has(project.status.category));
   }
   return scoped;
}

function applyDisplayFilters(list: Project[], filters: { health: string[]; priority: string[] }): Project[] {
   let filtered = list.slice();
   if (filters.health.length > 0) {
      const healthSet = new Set(filters.health);
      filtered = filtered.filter((project) => healthSet.has(project.health.id));
   }
   if (filters.priority.length > 0) {
      const prioritySet = new Set(filters.priority);
      filtered = filtered.filter((project) => prioritySet.has(project.priority.id));
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

/**
 * Projects page. With a `teamId` the whole page (tabs, filters, display
 * options, views, insights) is scoped to that team's projects.
 */
export default function Projects({ teamId }: { teamId?: string }) {
   const { filters, sort } = useProjectsFilterStore();
   const { viewTypes, grouping, ordering, closedProjects, showEmptyGroups } =
      useProjectsDisplayStore();
   const { openPanel, togglePanel } = useRightPanelStore();
   const allProjects = useProjectsStore((state) => state.projects);
   const issues = useIssuesStore((state) => state.issues);
   const teams = useTeamsStore((state) => state.teams);
   const workspace = useSessionStore((state) => state.workspace);
   const [tab, setTab] = useQueryState('tab', parseAsStringLiteral(TABS).withDefault('all'));
   const viewType = viewTypes[tab];

   const enriched = useMemo(
      () =>
         allProjects.map((project) => ({
            ...project,
            percentComplete: percentCompleteForProject(issues, project.id),
         })),
      [allProjects, issues]
   );

   const scoped = useMemo(
      () => applyTabScope(enriched, teamId, tab, closedProjects),
      [enriched, teamId, tab, closedProjects]
   );

   const displayed = useMemo(
      () => sortProjects(applyDisplayFilters(scoped, filters), sort, ordering),
      [scoped, filters, sort, ordering]
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

      if (grouping === 'status') {
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
      }

      const roster =
         teams.length > 0
            ? teams
            : [
                 {
                    id: workspace?.id ?? 'workspace',
                    name: workspace?.name ?? 'Workspace',
                    icon: '🫐',
                    joined: true,
                    color: '#6771c5',
                    members: [],
                    projects: [],
                 },
              ];

      return roster.map((team) => ({
         group: {
            id: team.id,
            name: team.name,
            color: team.color ?? '#6771c5',
            icon: <span className="text-sm leading-none">{team.icon}</span>,
         },
         projects: displayed.filter((project) => project.teamId === team.id),
         total: scoped.filter((project) => project.teamId === team.id).length,
      }));
   }, [displayed, grouping, scoped, teams, workspace]);

   const groups = useMemo<ProjectGroup[]>(() => {
      if (grouping === 'none') {
         return [{ id: 'all', name: 'All projects', projects: displayed }];
      }

      if (grouping === 'status') {
         return projectCreateStatusOptions
            .map((option) => ({
               id: option.status.id,
               name: option.label,
               projects: displayed.filter((project) => project.status.id === option.status.id),
            }))
            .filter((group) => showEmptyGroups || group.projects.length > 0);
      }

      const roster =
         teams.length > 0
            ? teams
            : [
                 {
                    id: workspace?.id ?? 'workspace',
                    name: workspace?.name ?? 'Workspace',
                    icon: '🫐',
                    joined: true,
                    color: '#6771c5',
                    members: [],
                    projects: [],
                 },
              ];

      return roster
         .map((team) => ({
            id: team.id,
            name: team.name,
            icon: team.icon,
            projects: displayed.filter((project) => project.teamId === team.id),
         }))
         .filter((group) => showEmptyGroups || group.projects.length > 0);
   }, [displayed, grouping, showEmptyGroups, workspace, teams]);

   return (
      <div className="w-full h-full flex flex-col overflow-hidden">
         <CreateProjectDialog />
         <div className="w-full flex justify-between items-center border-b py-1.5 px-6 h-10 shrink-0">
            <div className="flex items-center gap-1">
               {TAB_ITEMS.map((item) => {
                  const isActive = tab === item.value;
                  return (
                     <button
                        key={item.value}
                        type="button"
                        onClick={() => void setTab(item.value === 'all' ? null : item.value)}
                        className={cn(
                           'px-2.5 h-7 inline-flex items-center rounded-full border text-xs font-medium transition-colors',
                           isActive
                              ? 'bg-accent text-foreground border-border'
                              : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-accent/50'
                        )}
                     >
                        {item.label}
                     </button>
                  );
               })}
            </div>
            <div className="flex items-center gap-1">
               <Filter />
               <ProjectsDisplayOptions />
               <Button
                  size="xs"
                  variant={openPanel === 'insights' ? 'secondary' : 'ghost'}
                  onClick={() => togglePanel('insights')}
                  aria-label="Toggle projects insights panel"
               >
                  <BarChart3 className="size-4" />
               </Button>
            </div>
         </div>

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
                  <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                     No projects match these filters.
                  </div>
               ) : (
                  <>
                     {viewType === 'timeline' && <ProjectsTimeline groups={groups} />}
                     {viewType === 'list' && <ProjectsList groups={groups} />}
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
