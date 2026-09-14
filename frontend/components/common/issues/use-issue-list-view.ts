'use client';

import type { Issue } from '@/data/issues';
import { priorities } from '@/data/priorities';
import { status as allStatus } from '@/data/status';
import {
   type GroupingKey,
   type OrderingKey,
   type SortDirection,
   useDisplaySettingsStore,
} from '@/store/display-settings-store';
import { useViewStore, type ViewType } from '@/store/view-store';
import { parseAsString, parseAsStringLiteral, useQueryStates } from 'nuqs';
import { useCallback } from 'react';

export const VIEW_TYPES = ['list', 'grid', 'table', 'swimlane', 'gantt'] as const;
export const ORDERING_KEYS = [
   'manual',
   'status',
   'priority',
   'dueDate',
   'created',
   'updated',
   'title',
] as const;
const DIRECTIONS = ['asc', 'desc'] as const;

const parsers = {
   layout: parseAsStringLiteral(VIEW_TYPES),
   group: parseAsString,
   order: parseAsStringLiteral(ORDERING_KEYS),
   dir: parseAsStringLiteral(DIRECTIONS),
};

/** Groupings each layout can offer. The table and swimlanes take more. */
export function groupingKeysForMode(mode: ViewType): GroupingKey[] {
   switch (mode) {
      case 'table':
         return ['status', 'assignee', 'project', 'none'];
      case 'swimlane':
         return ['assignee', 'parent', 'project', 'status'];
      case 'gantt':
         return ['none', 'status', 'assignee'];
      default:
         return ['status', 'assignee', 'priority', 'project', 'none'];
   }
}

/** True when the layout can group by a workspace field as well. */
export function modeTakesPropertyGrouping(mode: ViewType): boolean {
   return mode === 'table' || mode === 'swimlane';
}

export function propertyIdOfGrouping(grouping: GroupingKey): string | null {
   return grouping.startsWith('property:') ? grouping.slice('property:'.length) : null;
}

const STATUS_ORDER = new Map(allStatus.map((entry, index) => [entry.id, index]));
const PRIORITY_ORDER = new Map(priorities.map((entry, index) => [entry.id, index]));

const time = (value: string | undefined): number => {
   if (!value) return Number.POSITIVE_INFINITY;
   const parsed = Date.parse(value);
   return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
};

/** Ascending comparison for one ordering; the direction is applied by the caller. */
function compareIssues(a: Issue, b: Issue, ordering: OrderingKey): number {
   switch (ordering) {
      case 'manual':
         return a.sortOrder - b.sortOrder || a.rank.localeCompare(b.rank);
      case 'status':
         return (STATUS_ORDER.get(a.status.id) ?? 99) - (STATUS_ORDER.get(b.status.id) ?? 99);
      case 'dueDate':
         return time(a.dueDate) - time(b.dueDate);
      case 'created':
         return time(a.createdAt) - time(b.createdAt);
      case 'updated':
         return time(a.updatedAt ?? a.createdAt) - time(b.updatedAt ?? b.createdAt);
      case 'title':
         return a.title.localeCompare(b.title);
      case 'priority':
      default:
         return (
            (PRIORITY_ORDER.get(a.priority.id) ?? 99) - (PRIORITY_ORDER.get(b.priority.id) ?? 99)
         );
   }
}

/**
 * Sorted copy. Ties fall back to the manual board order so a re-render cannot
 * shuffle rows that compare equal.
 */
export function sortIssues(
   issues: Issue[],
   ordering: OrderingKey,
   direction: SortDirection
): Issue[] {
   const sign = direction === 'desc' ? -1 : 1;
   return [...issues].sort((a, b) => {
      const primary = compareIssues(a, b, ordering);
      if (primary !== 0) return sign * primary;
      return a.sortOrder - b.sortOrder || a.rank.localeCompare(b.rank);
   });
}

/** Drops sub-tasks when the display switch says to; their parents keep the count. */
export function applySubIssueVisibility(issues: Issue[], showSubIssues: boolean): Issue[] {
   if (showSubIssues) return issues;
   const visible = new Set(issues.map((issue) => issue.id));
   return issues.filter((issue) => !issue.parentId || !visible.has(issue.parentId));
}

export interface IssueListView {
   mode: ViewType;
   grouping: GroupingKey;
   ordering: OrderingKey;
   direction: SortDirection;
   showSubIssues: boolean;
   showEmptyGroups: boolean;
   completedIssues: 'all' | 'none';
   setMode: (mode: ViewType) => void;
   setGrouping: (grouping: GroupingKey) => void;
   setOrdering: (ordering: OrderingKey) => void;
   setDirection: (direction: SortDirection) => void;
   /** True while the URL is carrying something other than the stored default. */
   isLinked: boolean;
}

/**
 * The layout and the display settings of a task list, URL first.
 *
 * Both halves are wanted: the stored settings are what a person keeps between
 * visits, and the URL is what they send to someone else. Reading the URL and
 * falling back to the store — rather than syncing one into the other — means a
 * shared link shows the sender's list without overwriting the reader's own
 * defaults, and no effect can loop between the two.
 */
export function useIssueListView(): IssueListView {
   const { viewType, setViewType } = useViewStore();
   const stored = useDisplaySettingsStore();
   const [url, setUrl] = useQueryStates(parsers, { history: 'replace' });

   const mode = url.layout ?? viewType;
   const grouping = (url.group as GroupingKey | null) ?? stored.groupingByMode[mode] ?? 'status';
   const ordering = url.order ?? stored.ordering;
   const direction = url.dir ?? stored.direction;

   const setMode = useCallback(
      (next: ViewType) => {
         setViewType(next);
         void setUrl({ layout: next });
      },
      [setViewType, setUrl]
   );

   const setGrouping = useCallback(
      (next: GroupingKey) => {
         stored.setGrouping(mode, next);
         void setUrl({ group: next });
      },
      [stored, mode, setUrl]
   );

   const setOrdering = useCallback(
      (next: OrderingKey) => {
         stored.setOrdering(next);
         void setUrl({ order: next });
      },
      [stored, setUrl]
   );

   const setDirection = useCallback(
      (next: SortDirection) => {
         stored.setDirection(next);
         void setUrl({ dir: next });
      },
      [stored, setUrl]
   );

   return {
      mode,
      grouping,
      ordering,
      direction,
      showSubIssues: stored.showSubIssues,
      showEmptyGroups: stored.showEmptyGroups,
      completedIssues: stored.completedIssues,
      setMode,
      setGrouping,
      setOrdering,
      setDirection,
      isLinked: url.layout !== null || url.group !== null || url.order !== null,
   };
}
