import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { ViewType } from './view-store';

/** What a list is grouped by. `property:<id>` groups by a workspace field. */
export type GroupingKey =
   'status' | 'assignee' | 'priority' | 'project' | 'parent' | 'none' | `property:${string}`;

export type OrderingKey =
   'manual' | 'status' | 'priority' | 'dueDate' | 'created' | 'updated' | 'title';

export type SortDirection = 'asc' | 'desc';
export type CompletedIssuesFilter = 'all' | 'none';

export type DisplayPropertyKey =
   'id' | 'status' | 'priority' | 'assignee' | 'labels' | 'project' | 'dueDate' | 'created';

export const DISPLAY_PROPERTIES: { key: DisplayPropertyKey; label: string }[] = [
   { key: 'id', label: 'ID' },
   { key: 'status', label: 'Status' },
   { key: 'assignee', label: 'Assignee' },
   { key: 'priority', label: 'Priority' },
   { key: 'labels', label: 'Labels' },
   { key: 'project', label: 'Project' },
   { key: 'dueDate', label: 'Due date' },
   { key: 'created', label: 'Created' },
];

const DEFAULT_DISPLAY_PROPERTIES: Record<DisplayPropertyKey, boolean> = {
   id: true,
   status: true,
   priority: true,
   assignee: true,
   labels: true,
   project: true,
   dueDate: false,
   created: true,
};

/**
 * Grouping is per layout, not global.
 *
 * A board grouped by status and a swimlane grid grouped by assignee are the
 * same list asking two different questions, and forcing one answer on both
 * meant switching layout silently re-grouped the other one.
 */
const DEFAULT_GROUPING: Record<ViewType, GroupingKey> = {
   list: 'status',
   grid: 'status',
   table: 'status',
   swimlane: 'assignee',
   gantt: 'none',
};

interface DisplaySettingsState {
   groupingByMode: Record<ViewType, GroupingKey>;
   ordering: OrderingKey;
   direction: SortDirection;
   orderCompletedByRecency: boolean;
   completedIssues: CompletedIssuesFilter;
   showSubIssues: boolean;
   showEmptyGroups: boolean;
   displayProperties: Record<DisplayPropertyKey, boolean>;
   /** Board columns hidden by hand, by group id. */
   hiddenBoardColumns: string[];

   setGrouping: (mode: ViewType, grouping: GroupingKey) => void;
   setOrdering: (ordering: OrderingKey) => void;
   setDirection: (direction: SortDirection) => void;
   setOrderCompletedByRecency: (value: boolean) => void;
   setCompletedIssues: (value: CompletedIssuesFilter) => void;
   setShowSubIssues: (value: boolean) => void;
   setShowEmptyGroups: (value: boolean) => void;
   toggleDisplayProperty: (key: DisplayPropertyKey) => void;
   hideBoardColumn: (groupId: string) => void;
   restoreBoardColumn: (groupId: string) => void;
   restoreAllBoardColumns: () => void;
   resetDisplaySettings: () => void;
}

const DEFAULTS = {
   groupingByMode: DEFAULT_GROUPING,
   ordering: 'priority' as OrderingKey,
   direction: 'asc' as SortDirection,
   orderCompletedByRecency: false,
   completedIssues: 'all' as CompletedIssuesFilter,
   showSubIssues: true,
   showEmptyGroups: false,
   displayProperties: DEFAULT_DISPLAY_PROPERTIES,
   hiddenBoardColumns: [] as string[],
};

/**
 * Display settings of the task lists: grouping per layout, ordering and its
 * direction, completed-task visibility, sub-tasks, hidden board columns and
 * the per-row properties. Persisted; the URL overrides it per link (see
 * `use-issue-list-view`).
 */
export const useDisplaySettingsStore = create<DisplaySettingsState>()(
   persist(
      (set) => ({
         ...DEFAULTS,

         setGrouping: (mode, grouping) =>
            set((state) => ({ groupingByMode: { ...state.groupingByMode, [mode]: grouping } })),
         setOrdering: (ordering) => set({ ordering }),
         setDirection: (direction) => set({ direction }),
         setOrderCompletedByRecency: (orderCompletedByRecency) => set({ orderCompletedByRecency }),
         setCompletedIssues: (completedIssues) => set({ completedIssues }),
         setShowSubIssues: (showSubIssues) => set({ showSubIssues }),
         setShowEmptyGroups: (showEmptyGroups) => set({ showEmptyGroups }),
         toggleDisplayProperty: (key) =>
            set((state) => ({
               displayProperties: {
                  ...state.displayProperties,
                  [key]: !state.displayProperties[key],
               },
            })),
         hideBoardColumn: (groupId) =>
            set((state) => ({
               hiddenBoardColumns: state.hiddenBoardColumns.includes(groupId)
                  ? state.hiddenBoardColumns
                  : [...state.hiddenBoardColumns, groupId],
            })),
         restoreBoardColumn: (groupId) =>
            set((state) => ({
               hiddenBoardColumns: state.hiddenBoardColumns.filter((entry) => entry !== groupId),
            })),
         restoreAllBoardColumns: () => set({ hiddenBoardColumns: [] }),
         resetDisplaySettings: () => set({ ...DEFAULTS }),
      }),
      {
         // Bumped with the shape: a stored v1 record has a single `grouping`
         // string where this one wants a map, and merging the two would leave
         // the board grouped by undefined.
         name: 'display-settings-v2',
         storage: createJSONStorage(() => localStorage),
      }
   )
);
