'use client';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { BerryMark } from '@/components/brand/berry-mark';
import { createColumnConfigHelper } from '@/components/data-table-filter/core/filters';
import { dateFilterOperators } from '@/components/data-table-filter/core/operators';
import type { ColumnOption, FiltersState } from '@/components/data-table-filter/core/types';
import {
   dateFilterFn,
   multiOptionFilterFn,
   optionFilterFn,
   textFilterFn,
} from '@/components/data-table-filter/lib/filter-fns';
import { Issue } from '@/data/issues';
import type { LabelInterface } from '@/data/labels';
import { priorities } from '@/data/priorities';
import { status, StatusCategory } from '@/data/status';
import type { Project } from '@/data/projects';
import type { User } from '@/data/users';
import { agentToUser, type Agent } from '@/lib/agents';
import { loadProperties, type PropertyDefinition } from '@/lib/properties';
import { listSquads, type Squad } from '@/lib/squads';
import { queryIssues } from '@/lib/views';
import { useAgentsStore } from '@/store/agents-store';
import { useLabelsStore } from '@/store/labels-store';
import { useMembersStore } from '@/store/members-store';
import { useProjectsStore } from '@/store/projects-store';
import { useSessionStore } from '@/store/session-store';
import {
   BarChart3,
   CalendarClock,
   CalendarPlus,
   CircleCheck,
   CircleDashed,
   CircleUserRound,
   Folder,
   Tag,
   UserPen,
   Users,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

/* -------------------------------------------------------------------------- */
/*                                Option lists                                */
/* -------------------------------------------------------------------------- */

/** Option value standing for "this field has no value at all". */
export const EMPTY_PROPERTY_VALUE = '__empty__';

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

function personOption(person: User): ColumnOption {
   return {
      value: person.id,
      label: person.name,
      icon:
         person.role === 'Application' ? (
            <BerryMark size="sm" tone="working" label={`${person.name}, agent`} />
         ) : (
            <Avatar className="size-4">
               <AvatarImage src={person.avatarUrl} alt={person.name} />
               <AvatarFallback>{person.name[0]}</AvatarFallback>
            </Avatar>
         ),
   };
}

/** Members and agents can both hold a task, so both belong in the menu. */
function buildAssigneeOptions(members: User[], agents: User[]): ColumnOption[] {
   return [
      {
         value: 'unassigned',
         label: 'No assignee',
         icon: <CircleUserRound className="size-4 text-muted-foreground" />,
      },
      ...members.map(personOption),
      ...agents.map(personOption),
   ];
}

function buildCreatorOptions(members: User[], agents: User[]): ColumnOption[] {
   return [
      {
         value: 'unknown',
         label: 'Unknown',
         icon: <UserPen className="size-4 text-muted-foreground" />,
      },
      ...members.map(personOption),
      ...agents.map(personOption),
   ];
}

function buildSquadOptions(squads: Squad[]): ColumnOption[] {
   return squads.map((squad) => ({
      value: squad.id,
      label: squad.name,
      icon: <Users className="size-4 text-muted-foreground" />,
   }));
}

function buildLabelOptions(workspaceLabels: LabelInterface[]): ColumnOption[] {
   return workspaceLabels.map((label) => ({
      value: label.id,
      label: label.name,
      icon: <span className="size-2.5 rounded-full" style={{ backgroundColor: label.color }} />,
   }));
}

function buildProjectOptions(workspaceProjects: Project[]): ColumnOption[] {
   return [
      {
         value: 'no-project',
         label: 'No project',
         icon: <Folder className="size-4 text-muted-foreground" />,
      },
      ...workspaceProjects.map((project) => ({
         value: project.id,
         label: project.name,
         icon: <project.icon className="size-4 text-muted-foreground" />,
      })),
   ];
}

/** Squad ids whose roster (or leader) holds this task. */
function squadIdsForIssue(issue: Issue, squads: Squad[]): string[] {
   const assigneeId = issue.assignee?.id;
   if (!assigneeId) return [];
   return squads
      .filter(
         (squad) =>
            squad.leaderAgentId === assigneeId ||
            squad.members.some((member) => member.id === assigneeId)
      )
      .map((squad) => squad.id);
}

const asDate = (value: string | undefined): Date => (value ? new Date(value) : new Date(0));

function buildIssueFilterColumns(
   members: User[],
   agents: User[],
   squads: Squad[],
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
         .options(buildAssigneeOptions(members, agents))
         .build(),
      dtf
         .multiOption()
         .id('squad')
         .accessor((issue: Issue) => squadIdsForIssue(issue, squads))
         .displayName('Squad')
         .icon(Users)
         .options(buildSquadOptions(squads))
         .build(),
      dtf
         .option()
         .id('creator')
         .accessor((issue: Issue) => issue.creator?.id ?? 'unknown')
         .displayName('Creator')
         .icon(UserPen)
         .options(buildCreatorOptions(members, agents))
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
         .accessor((issue: Issue) => issue.project?.id ?? 'no-project')
         .displayName('Project')
         .icon(Folder)
         .options(buildProjectOptions(workspaceProjects))
         .build(),
      dtf
         .date()
         .id('createdAt')
         .accessor((issue: Issue) => asDate(issue.createdAt))
         .displayName('Created')
         .icon(CalendarPlus)
         .build(),
      dtf
         .date()
         .id('updatedAt')
         .accessor((issue: Issue) => asDate(issue.updatedAt ?? issue.createdAt))
         .displayName('Updated')
         .icon(CalendarClock)
         .build(),
   ] as const;
}

/* -------------------------------------------------------------------------- */
/*                             Workspace fields                               */
/* -------------------------------------------------------------------------- */

const PROPERTY_PREFIX = 'property:';

export const isPropertyColumnId = (columnId: string): boolean =>
   columnId.startsWith(PROPERTY_PREFIX);

const propertyIdOf = (columnId: string): string => columnId.slice(PROPERTY_PREFIX.length);

/**
 * One filter column per workspace field.
 *
 * Field values are not on the task payload, so these columns carry no usable
 * accessor: what they match is decided by the server (see
 * `usePropertyFilterMatches`) and the accessor exists only to satisfy the
 * filter library.
 */
function buildPropertyColumns(definitions: PropertyDefinition[]) {
   const dtf = createColumnConfigHelper<Issue>();
   return definitions.map((definition) => {
      const id = `${PROPERTY_PREFIX}${definition.id}`;
      const emptyOption: ColumnOption = {
         value: EMPTY_PROPERTY_VALUE,
         label: 'Empty',
         icon: <CircleDashed className="size-4 text-muted-foreground" />,
      };
      switch (definition.kind) {
         case 'select':
         case 'multi_select':
            return dtf
               .option()
               .id(id)
               .accessor(() => '')
               .displayName(definition.name)
               .icon(CircleDashed)
               .options([
                  emptyOption,
                  ...definition.options.map((option) => ({
                     value: option.id,
                     label: option.name,
                     icon: (
                        <span
                           className="size-2.5 rounded-full"
                           style={{ backgroundColor: option.color }}
                        />
                     ),
                  })),
               ])
               .build();
         case 'boolean':
            return dtf
               .option()
               .id(id)
               .accessor(() => '')
               .displayName(definition.name)
               .icon(CircleDashed)
               .options([
                  { value: 'true', label: 'Checked' },
                  { value: 'false', label: 'Unchecked' },
                  emptyOption,
               ])
               .build();
         case 'date':
            return dtf
               .date()
               .id(id)
               .accessor(() => new Date(0))
               .displayName(definition.name)
               .icon(CalendarClock)
               .build();
         default:
            return dtf
               .text()
               .id(id)
               .accessor(() => '')
               .displayName(definition.name)
               .icon(CircleDashed)
               .build();
      }
   });
}

/** The workspace's squads, loaded once per mount. */
function useSquads(): Squad[] {
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? '');
   const [squads, setSquads] = useState<Squad[]>([]);

   useEffect(() => {
      if (!workspaceId) return;
      let cancelled = false;
      void listSquads()
         .then((loaded) => {
            if (!cancelled) setSquads(loaded.filter((squad) => !squad.archivedAt));
         })
         .catch(() => undefined);
      return () => {
         cancelled = true;
      };
   }, [workspaceId]);

   return squads;
}

/** The workspace's custom fields, loaded once per mount. */
function useFilterableProperties(): PropertyDefinition[] {
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? '');
   const [definitions, setDefinitions] = useState<PropertyDefinition[]>([]);

   useEffect(() => {
      if (!workspaceId) return;
      let cancelled = false;
      void loadProperties(workspaceId)
         .then((loaded) => {
            if (!cancelled) setDefinitions(loaded.filter((entry) => !entry.archivedAt));
         })
         .catch(() => undefined);
      return () => {
         cancelled = true;
      };
   }, [workspaceId]);

   return definitions;
}

/** Live filter columns backed by workspace API data. */
export function useIssueFilterColumns() {
   const members = useMembersStore((state) => state.members);
   const agentRecords = useAgentsStore((state) => state.agents);
   const workspaceLabels = useLabelsStore((state) => state.labels);
   const workspaceProjects = useProjectsStore((state) => state.projects);
   const squads = useSquads();
   const properties = useFilterableProperties();

   const agents = useMemo(
      () => agentRecords.map((agent: Agent) => agentToUser(agent)),
      [agentRecords]
   );

   return useMemo(
      () => [
         ...buildIssueFilterColumns(members, agents, squads, workspaceLabels, workspaceProjects),
         ...buildPropertyColumns(properties),
      ],
      [members, agents, squads, workspaceLabels, workspaceProjects, properties]
   );
}

/** Static fallback for non-hook contexts (empty assignee/label/project options). */
export const issueFilterColumns = buildIssueFilterColumns([], [], [], [], []);

const columnById = new Map<string, (typeof issueFilterColumns)[number]>(
   issueFilterColumns.map((column) => [column.id, column])
);

/* -------------------------------------------------------------------------- */
/*                          Server-matched field filters                      */
/* -------------------------------------------------------------------------- */

type ServerPropertyFilter =
   | { propertyId: string; op: 'isSet' }
   | { propertyId: string; op: 'notSet' }
   | { propertyId: string; op: 'eq'; value: string | number | boolean }
   | { propertyId: string; op: 'in'; values: string[] }
   | { propertyId: string; op: 'contains'; value: string }
   | { propertyId: string; op: 'gt'; value: string | number }
   | { propertyId: string; op: 'lt'; value: string | number };

const isoDay = (value: unknown): string | null => {
   const date = value instanceof Date ? value : new Date(String(value));
   return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
};

/** One filter chip on a workspace field, in the shape the view query takes. */
function toServerPropertyFilter(
   propertyId: string,
   filter: FiltersState[number]
): ServerPropertyFilter | null {
   const values = filter.values as unknown[];
   const first = values[0];
   if (first === undefined) return null;

   if (filter.type === 'option' || filter.type === 'multiOption') {
      const strings = values.map((value) => String(value));
      if (strings.includes(EMPTY_PROPERTY_VALUE)) {
         return { propertyId, op: 'notSet' };
      }
      if (strings.length === 1) {
         const only = strings[0];
         if (only === 'true' || only === 'false') {
            return { propertyId, op: 'eq', value: only === 'true' };
         }
         return { propertyId, op: 'eq', value: only };
      }
      return { propertyId, op: 'in', values: strings };
   }

   if (filter.type === 'text') {
      const text = String(first).trim();
      return text ? { propertyId, op: 'contains', value: text } : null;
   }

   if (filter.type === 'date') {
      const day = isoDay(first);
      if (!day) return null;
      switch (filter.operator) {
         case 'is before':
         case 'is on or before':
            return { propertyId, op: 'lt', value: day };
         case 'is after':
         case 'is on or after':
            return { propertyId, op: 'gt', value: day };
         default:
            return { propertyId, op: 'eq', value: day };
      }
   }

   return null;
}

/**
 * Which tasks match the active workspace-field filters, answered by the server.
 *
 * `null` means no field filter is on and every task passes. The query returns
 * at most 200 ids per call, which is the ceiling the view query enforces; a
 * workspace past that filters on the server anyway once paging lands.
 */
export function usePropertyFilterMatches(filters: FiltersState): Set<string> | null {
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? '');
   const [matches, setMatches] = useState<Set<string> | null>(null);

   const serverFilters = useMemo(() => {
      const built: ServerPropertyFilter[] = [];
      for (const filter of filters) {
         if (!isPropertyColumnId(filter.columnId)) continue;
         const mapped = toServerPropertyFilter(propertyIdOf(filter.columnId), filter);
         if (mapped) built.push(mapped);
      }
      return built;
   }, [filters]);

   const key = JSON.stringify(serverFilters);

   useEffect(() => {
      if (!workspaceId || serverFilters.length === 0) {
         setMatches(null);
         return;
      }
      let cancelled = false;
      void queryIssues({
         workspaceId,
         filter: { properties: serverFilters },
         groupBy: 'none',
         perGroup: 200,
      })
         .then((result) => {
            if (cancelled) return;
            const ids = new Set<string>();
            for (const group of result.groups) {
               for (const id of group.issueIds) ids.add(id);
            }
            setMatches(ids);
         })
         .catch(() => {
            // A failed query must not silently widen the list: an empty set
            // shows nothing, which is honest about having no answer.
            if (!cancelled) setMatches(new Set<string>());
         });
      return () => {
         cancelled = true;
      };
      // `key` stands in for the filter array, which is rebuilt every render.
   }, [workspaceId, key, serverFilters]);

   return serverFilters.length > 0 ? matches : null;
}

/**
 * Applies a bazza/ui FiltersState to a list of issues, honoring the
 * operator of each filter (is / is not / include / exclude / before / …).
 *
 * Workspace-field filters are not evaluated here — their values live on the
 * server. Pass the ids from `usePropertyFilterMatches` and they are applied as
 * one intersection.
 */
export function applyIssueFilters(
   issues: Issue[],
   filters: FiltersState,
   propertyMatches?: Set<string> | null
): Issue[] {
   if (filters.length === 0) return issues;

   const scoped = propertyMatches
      ? issues.filter((issue) => propertyMatches.has(issue.id))
      : issues;

   return scoped.filter((issue) =>
      filters.every((filter) => {
         if (isPropertyColumnId(filter.columnId)) return true;
         const column = columnById.get(filter.columnId);
         if (!column) return true;

         const value = column.accessor(issue);
         switch (filter.type) {
            case 'option':
               return optionFilterFn(String(value ?? ''), filter) ?? true;
            case 'multiOption':
               return multiOptionFilterFn((value as string[]) ?? [], filter) ?? true;
            case 'date': {
               // A singular operator with a leftover range would throw inside
               // the filter function, so the extra value is dropped instead.
               const operators = dateFilterOperators as Record<
                  string,
                  { target: string } | undefined
               >;
               const singular = operators[String(filter.operator)]?.target === 'single';
               const normalised =
                  singular && filter.values.length > 1
                     ? { ...filter, values: filter.values.slice(0, 1) }
                     : filter;
               return dateFilterFn(value as Date, normalised) ?? true;
            }
            case 'text':
               return textFilterFn(String(value ?? ''), filter) ?? true;
            default:
               return true;
         }
      })
   );
}
