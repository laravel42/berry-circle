'use client';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import type { Issue } from '@/data/issues';
import { priorities } from '@/data/priorities';
import type { Status } from '@/data/status';
import { loadProperties, type PropertyDefinition } from '@/lib/properties';
import { queryIssues } from '@/lib/views';
import type { GroupingKey } from '@/store/display-settings-store';
import { useSessionStore } from '@/store/session-store';
import { Box, CircleDashed, Layers, User } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { IssueGroupDescriptor } from './group-issues';
import { propertyIdOfGrouping } from './use-issue-list-view';

export interface IssueGroupEntry {
   group: IssueGroupDescriptor;
   /** Issues of the group after the filters. */
   issues: Issue[];
   /** Issues of the group before the filters, for the "0 / n" columns. */
   total: number;
}

const NEUTRAL = '#8f9299';

function bucket(issues: Issue[], keyOf: (issue: Issue) => string): Map<string, Issue[]> {
   const map = new Map<string, Issue[]>();
   for (const issue of issues) {
      const key = keyOf(issue);
      map.set(key, [...(map.get(key) ?? []), issue]);
   }
   return map;
}

/** Group key of one issue under a grouping, so a drop target can name itself. */
export function groupKeyOf(issue: Issue, grouping: GroupingKey): string {
   switch (grouping) {
      case 'assignee':
         return issue.assignee?.id ?? 'no-assignee';
      case 'priority':
         return issue.priority.id;
      case 'project':
         return issue.project?.id ?? 'no-project';
      case 'parent':
         return issue.parentId ?? 'no-parent';
      case 'none':
         return 'all';
      case 'status':
      default:
         return issue.status.id;
   }
}

export interface PropertyGrouping {
   definition: PropertyDefinition | undefined;
   /** Issue id to group key, from the server's grouped query. */
   keyOf: Map<string, string>;
   /** Group keys in the order the server returned them. */
   keys: string[];
   /** The grouping asked for a field the workspace no longer has. */
   missing: boolean;
}

/**
 * Groups by a workspace field, counted by the server.
 *
 * Field values are not on the task list payload — they live in their own
 * table — so grouping by one is asked of `/views/query`, which already knows
 * how to group by a property id, rather than by fetching every task's fields
 * one at a time.
 */
export function usePropertyGrouping(grouping: GroupingKey): PropertyGrouping | null {
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? '');
   const propertyId = propertyIdOfGrouping(grouping);
   const [result, setResult] = useState<PropertyGrouping | null>(null);

   useEffect(() => {
      if (!workspaceId || !propertyId) {
         setResult(null);
         return;
      }
      let cancelled = false;
      void Promise.all([
         loadProperties(workspaceId).catch(() => [] as PropertyDefinition[]),
         queryIssues({
            workspaceId,
            groupBy: { propertyId },
            perGroup: 200,
         }).catch(() => null),
      ]).then(([definitions, query]) => {
         if (cancelled) return;
         const definition = definitions.find((entry) => entry.id === propertyId);
         const keyOf = new Map<string, string>();
         const keys: string[] = [];
         for (const group of query?.groups ?? []) {
            keys.push(group.key);
            for (const issueId of group.issueIds) keyOf.set(issueId, group.key);
         }
         setResult({ definition, keyOf, keys, missing: !definition });
      });
      return () => {
         cancelled = true;
      };
   }, [workspaceId, propertyId]);

   return propertyId ? result : null;
}

/**
 * The value each task holds for a set of workspace fields, keyed
 * `property:<id>|<issueId>`.
 *
 * One grouped query per field rather than one read per task: a table of forty
 * rows showing two fields is two requests instead of eighty.
 */
export function usePropertyValues(propertyIds: string[]): Map<string, string> {
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? '');
   const [values, setValues] = useState<Map<string, string>>(new Map());
   const key = propertyIds.join(',');

   useEffect(() => {
      const ids = key ? key.split(',') : [];
      if (!workspaceId || ids.length === 0) {
         setValues(new Map());
         return;
      }
      let cancelled = false;
      void Promise.all(
         ids.map((propertyId) =>
            queryIssues({ workspaceId, groupBy: { propertyId }, perGroup: 200 })
               .then((result) => ({ propertyId, result }))
               .catch(() => ({ propertyId, result: null }))
         )
      ).then((loaded) => {
         if (cancelled) return;
         const next = new Map<string, string>();
         for (const { propertyId, result } of loaded) {
            for (const group of result?.groups ?? []) {
               if (!group.key || group.key === 'none') continue;
               for (const issueId of group.issueIds) {
                  next.set(`property:${propertyId}|${issueId}`, group.key);
               }
            }
         }
         setValues(next);
      });
      return () => {
         cancelled = true;
      };
   }, [workspaceId, key]);

   return values;
}

/** The workspace's custom fields, for the grouping menu. */
export function useWorkspaceProperties(): PropertyDefinition[] {
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

interface BuildInput {
   issues: Issue[];
   totalIssues: Issue[];
   statuses: Status[];
   grouping: GroupingKey;
   property?: PropertyGrouping | null;
}

/**
 * The groups a list renders, as descriptors plus their issues.
 *
 * Shared by the list, the board, the table and the swimlanes: the four of them
 * disagreeing about what "grouped by assignee" means is how a board column and
 * a table section end up with different counts for the same field.
 */
export function buildIssueGroups({
   issues,
   totalIssues,
   statuses,
   grouping,
   property,
}: BuildInput): IssueGroupEntry[] {
   if (grouping.startsWith('property:')) {
      const keyOf = property?.keyOf ?? new Map<string, string>();
      const labelOf = (key: string): string => {
         if (!key || key === 'none') return 'No value';
         const option = property?.definition?.options.find((entry) => entry.id === key);
         return option?.name ?? key;
      };
      const visible = bucket(issues, (issue) => keyOf.get(issue.id) ?? 'none');
      const totals = bucket(totalIssues, (issue) => keyOf.get(issue.id) ?? 'none');
      const keys = [...new Set([...(property?.keys ?? []), ...totals.keys()])];
      return keys.map((key) => ({
         group: {
            id: `property:${key}`,
            name: labelOf(key),
            color: NEUTRAL,
            icon: <CircleDashed className="size-4 text-muted-foreground" />,
         },
         issues: visible.get(key) ?? [],
         total: (totals.get(key) ?? []).length,
      }));
   }

   switch (grouping) {
      case 'assignee': {
         const keyOf = (issue: Issue) => issue.assignee?.id ?? 'no-assignee';
         const totals = bucket(totalIssues, keyOf);
         const visible = bucket(issues, keyOf);
         return [...totals.entries()]
            .sort((a, b) => b[1].length - a[1].length)
            .map(([key, group]) => {
               const assignee = group[0].assignee;
               return {
                  group: {
                     id: key,
                     name: assignee?.name ?? 'No assignee',
                     color: NEUTRAL,
                     icon: assignee ? (
                        <Avatar className="size-4">
                           <AvatarImage src={assignee.avatarUrl} alt={assignee.name} />
                           <AvatarFallback>{assignee.name[0]}</AvatarFallback>
                        </Avatar>
                     ) : (
                        <User className="size-4 text-muted-foreground" />
                     ),
                  },
                  issues: visible.get(key) ?? [],
                  total: group.length,
               };
            });
      }
      case 'priority':
         return priorities.map((priority) => ({
            group: {
               id: priority.id,
               name: priority.name,
               color: NEUTRAL,
               icon: <priority.icon className="size-4" />,
            },
            issues: issues.filter((issue) => issue.priority.id === priority.id),
            total: totalIssues.filter((issue) => issue.priority.id === priority.id).length,
         }));
      case 'project': {
         const keyOf = (issue: Issue) => issue.project?.id ?? 'no-project';
         const totals = bucket(totalIssues, keyOf);
         const visible = bucket(issues, keyOf);
         return [...totals.entries()]
            .sort((a, b) => b[1].length - a[1].length)
            .map(([key, group]) => {
               const project = group[0].project;
               const Icon = project?.icon ?? Box;
               return {
                  group: {
                     id: key,
                     name: project?.name ?? 'No project',
                     color: NEUTRAL,
                     icon: <Icon className="size-4 text-muted-foreground" />,
                  },
                  issues: visible.get(key) ?? [],
                  total: group.length,
               };
            });
      }
      case 'parent': {
         const titleOf = new Map(totalIssues.map((issue) => [issue.id, issue.title]));
         const keyOf = (issue: Issue) => issue.parentId ?? 'no-parent';
         const totals = bucket(totalIssues, keyOf);
         const visible = bucket(issues, keyOf);
         return [...totals.entries()]
            .sort((a, b) => (a[0] === 'no-parent' ? 1 : b[0] === 'no-parent' ? -1 : 0))
            .map(([key, group]) => ({
               group: {
                  id: key,
                  name: key === 'no-parent' ? 'No parent' : (titleOf.get(key) ?? 'Parent task'),
                  color: NEUTRAL,
                  icon: <Layers className="size-4 text-muted-foreground" />,
               },
               issues: visible.get(key) ?? [],
               total: group.length,
            }));
      }
      case 'none':
         return [
            {
               group: {
                  id: 'all',
                  name: 'All tasks',
                  color: NEUTRAL,
                  icon: <Box className="size-4 text-muted-foreground" />,
               },
               issues,
               total: totalIssues.length,
            },
         ];
      case 'status':
      default:
         return statuses.map((entry) => ({
            group: {
               id: entry.id,
               name: entry.name,
               color: entry.color,
               icon: <entry.icon />,
               status: entry,
            },
            issues: issues.filter((issue) => issue.status.id === entry.id),
            total: totalIssues.filter((issue) => issue.status.id === entry.id).length,
         }));
   }
}

/** Memoised `buildIssueGroups`, for the components that re-render on every keystroke. */
export function useIssueGroups(input: BuildInput): IssueGroupEntry[] {
   const { issues, totalIssues, statuses, grouping, property } = input;
   return useMemo(
      () => buildIssueGroups({ issues, totalIssues, statuses, grouping, property }),
      [issues, totalIssues, statuses, grouping, property]
   );
}
