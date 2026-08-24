'use client';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { createColumnConfigHelper } from '@/components/data-table-filter/core/filters';
import type { ColumnOption, FiltersState } from '@/components/data-table-filter/core/types';
import { multiOptionFilterFn, optionFilterFn } from '@/components/data-table-filter/lib/filter-fns';
import { cycles, cycleStatusLabel } from '@/data/cycles';
import { Issue } from '@/data/issues';
import type { LabelInterface } from '@/data/labels';
import { priorities } from '@/data/priorities';
import { status, StatusCategory } from '@/data/status';
import type { Project } from '@/data/projects';
import type { User } from '@/data/users';
import { useLabelsStore } from '@/store/labels-store';
import { useMembersStore } from '@/store/members-store';
import { useProjectsStore } from '@/store/projects-store';
import {
   BarChart3,
   CircleCheck,
   CircleDashed,
   CircleUserRound,
   Folder,
   RefreshCcw,
   Tag,
} from 'lucide-react';
import { useMemo } from 'react';

/* -------------------------------------------------------------------------- */
/*                                Option lists                                */
/* -------------------------------------------------------------------------- */

const statusOptions: ColumnOption[] = status.map((item) => ({
   value: item.id,
   label: item.name,
   icon: <item.icon />,
}));

const STATUS_TYPES: { id: StatusCategory; name: string }[] = [
   { id: 'backlog', name: 'Backlog' },
   { id: 'unstarted', name: 'Unstarted' },
   { id: 'started', name: 'Started' },
   { id: 'completed', name: 'Completed' },
   { id: 'canceled', name: 'Cancelled' },
];

const statusTypeOptions: ColumnOption[] = STATUS_TYPES.map((item) => ({
   value: item.id,
   label: item.name,
   icon: <CircleDashed className="size-4 text-muted-foreground" />,
}));

const priorityOptions: ColumnOption[] = priorities.map((priority) => ({
   value: priority.id,
   label: priority.name,
   icon: <priority.icon className="size-4 text-muted-foreground" />,
}));

const cycleOptions: ColumnOption[] = [
   {
      value: 'no-cycle',
      label: 'No cycle',
      icon: <RefreshCcw className="size-4 text-muted-foreground" />,
   },
   ...cycles.map((cycle) => ({
      value: cycle.id,
      label: `${cycle.name} (${cycleStatusLabel[cycle.status]})`,
      icon: <RefreshCcw className="size-4 text-muted-foreground" />,
   })),
];

function buildAssigneeOptions(members: User[]): ColumnOption[] {
   return [
      {
         value: 'unassigned',
         label: 'Unassigned',
         icon: <CircleUserRound className="size-4 text-muted-foreground" />,
      },
      ...members.map((user) => ({
         value: user.id,
         label: user.name,
         icon: (
            <Avatar className="size-4">
               <AvatarImage src={user.avatarUrl} alt={user.name} />
               <AvatarFallback>{user.name[0]}</AvatarFallback>
            </Avatar>
         ),
      })),
   ];
}

function buildLabelOptions(workspaceLabels: LabelInterface[]): ColumnOption[] {
   return workspaceLabels.map((label) => ({
      value: label.id,
      label: label.name,
      icon: <span className="size-2.5 rounded-full" style={{ backgroundColor: label.color }} />,
   }));
}

function buildProjectOptions(workspaceProjects: Project[]): ColumnOption[] {
   return workspaceProjects.map((project) => ({
      value: project.id,
      label: project.name,
      icon: <project.icon className="size-4 text-muted-foreground" />,
   }));
}

function buildIssueFilterColumns(
   members: User[],
   workspaceLabels: LabelInterface[],
   workspaceProjects: Project[]
) {
   const dtf = createColumnConfigHelper<Issue>();
   return [
      dtf
         .option()
         .id('status')
         .accessor((issue: Issue) => issue.status.id)
         .displayName('Status')
         .icon(CircleCheck)
         .options(statusOptions)
         .build(),
      dtf
         .option()
         .id('statusType')
         .accessor((issue: Issue) => issue.status.category)
         .displayName('Status type')
         .icon(CircleDashed)
         .options(statusTypeOptions)
         .build(),
      dtf
         .option()
         .id('assignee')
         .accessor((issue: Issue) => issue.assignee?.id ?? 'unassigned')
         .displayName('Assignee')
         .icon(CircleUserRound)
         .options(buildAssigneeOptions(members))
         .build(),
      dtf
         .option()
         .id('priority')
         .accessor((issue: Issue) => issue.priority.id)
         .displayName('Priority')
         .icon(BarChart3)
         .options(priorityOptions)
         .build(),
      dtf
         .multiOption()
         .id('labels')
         .accessor((issue: Issue) => issue.labels.map((label) => label.id))
         .displayName('Labels')
         .icon(Tag)
         .options(buildLabelOptions(workspaceLabels))
         .build(),
      dtf
         .option()
         .id('project')
         .accessor((issue: Issue) => issue.project?.id ?? '')
         .displayName('Project')
         .icon(Folder)
         .options(buildProjectOptions(workspaceProjects))
         .build(),
      dtf
         .option()
         .id('cycle')
         .accessor((issue: Issue) => (issue.cycleId === '' ? 'no-cycle' : issue.cycleId))
         .displayName('Cycle')
         .icon(RefreshCcw)
         .options(cycleOptions)
         .build(),
   ] as const;
}

/** Live filter columns backed by workspace API data. */
export function useIssueFilterColumns() {
   const members = useMembersStore((state) => state.members);
   const workspaceLabels = useLabelsStore((state) => state.labels);
   const workspaceProjects = useProjectsStore((state) => state.projects);
   return useMemo(
      () => buildIssueFilterColumns(members, workspaceLabels, workspaceProjects),
      [members, workspaceLabels, workspaceProjects]
   );
}

/** Static fallback for non-hook contexts (empty assignee/label/project options). */
export const issueFilterColumns = buildIssueFilterColumns([], [], []);

const columnById = new Map<string, (typeof issueFilterColumns)[number]>(
   issueFilterColumns.map((column) => [column.id, column])
);

/**
 * Applies a bazza/ui FiltersState to a list of issues, honoring the
 * operator of each filter (is / is not / include / exclude / …).
 */
export function applyIssueFilters(issues: Issue[], filters: FiltersState): Issue[] {
   if (filters.length === 0) return issues;

   return issues.filter((issue) =>
      filters.every((filter) => {
         const column = columnById.get(filter.columnId);
         if (!column) return true;

         const value = column.accessor(issue);
         switch (filter.type) {
            case 'option':
               return optionFilterFn(String(value ?? ''), filter) ?? true;
            case 'multiOption':
               return multiOptionFilterFn((value as string[]) ?? [], filter) ?? true;
            default:
               return true;
         }
      })
   );
}
