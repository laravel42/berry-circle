import { create } from 'zustand';

/**
 * What the agents list is currently showing.
 *
 * Held outside the table because the toolbar that sets it and the table that
 * reads it are mounted separately — the page gives one to `MainLayout` as a
 * header and the other as its body, so they have no common parent to hold
 * this between them.
 */

/** Whose agents: the ones I made, every live one, or the archive. */
export type AgentsScope = 'mine' | 'all' | 'archived';

export type AgentsSortKey = 'activity' | 'name' | 'runs' | 'created';

export type AgentColumn =
   | 'presence'
   | 'workload'
   | 'runtime'
   | 'activity'
   | 'runs'
   | 'lastActive'
   | 'model'
   | 'owner'
   | 'access';

/** Every column the picker offers, in the order the table lays them out. */
export const AGENT_COLUMNS: AgentColumn[] = [
   'presence',
   'workload',
   'runtime',
   'activity',
   'runs',
   'lastActive',
   'model',
   'owner',
   'access',
];

/** The columns a fresh workspace sees: what the agent is doing, and on what. */
const DEFAULT_COLUMNS: AgentColumn[] = [
   'presence',
   'workload',
   'runtime',
   'activity',
   'runs',
   'lastActive',
   'model',
];

export interface AgentFilters {
   /** A status name, or null for any. */
   availability: string | null;
   /** An access scope (`everyone`, `admins`, `listed`), or null for any. */
   access: string | null;
   /** A runtime id, `none` for agents with no runtime, or null for any. */
   runtime: string | null;
   /** A member id, `workspace` for authorless agents, or null for any. */
   owner: string | null;
   /** A `provider/model` pairing, or null for any. */
   model: string | null;
}

export const EMPTY_FILTERS: AgentFilters = {
   availability: null,
   access: null,
   runtime: null,
   owner: null,
   model: null,
};

interface AgentsListState {
   scope: AgentsScope;
   search: string;
   sortKey: AgentsSortKey;
   /** Descending is the useful default for activity and runs, not for a name. */
   sortDescending: boolean;
   filters: AgentFilters;
   columns: AgentColumn[];
   /** Ids ticked for a bulk action. Cleared whenever the scope changes. */
   selected: string[];
   setScope: (scope: AgentsScope) => void;
   setSearch: (search: string) => void;
   /** Clicking the column already sorted on flips the direction. */
   sortBy: (key: AgentsSortKey) => void;
   setFilter: (key: keyof AgentFilters, value: string | null) => void;
   clearFilters: () => void;
   toggleColumn: (column: AgentColumn) => void;
   toggleSelected: (id: string) => void;
   setSelected: (ids: string[]) => void;
   clearSelection: () => void;
}

export const useAgentsListStore = create<AgentsListState>((set, get) => ({
   scope: 'all',
   search: '',
   sortKey: 'activity',
   sortDescending: true,
   filters: EMPTY_FILTERS,
   columns: DEFAULT_COLUMNS,
   selected: [],

   // A selection made in one scope means nothing in another: the rows it
   // referred to are not on screen to be unticked.
   setScope: (scope) => set({ scope, selected: [] }),
   setSearch: (search) => set({ search }),

   sortBy: (key) =>
      set((state) =>
         state.sortKey === key
            ? { sortDescending: !state.sortDescending }
            : { sortKey: key, sortDescending: key !== 'name' }
      ),

   setFilter: (key, value) => set((state) => ({ filters: { ...state.filters, [key]: value } })),
   clearFilters: () => set({ filters: EMPTY_FILTERS }),

   toggleColumn: (column) =>
      set((state) => ({
         columns: state.columns.includes(column)
            ? state.columns.filter((entry) => entry !== column)
            : AGENT_COLUMNS.filter((entry) => entry === column || state.columns.includes(entry)),
      })),

   toggleSelected: (id) =>
      set((state) => ({
         selected: state.selected.includes(id)
            ? state.selected.filter((entry) => entry !== id)
            : [...state.selected, id],
      })),
   setSelected: (ids) => set({ selected: ids }),
   clearSelection: () => set({ selected: [] }),
}));

/** Whether any filter is narrowing the list, for the "clear" affordance. */
export function hasActiveFilters(filters: AgentFilters): boolean {
   return Object.values(filters).some((value) => value !== null);
}

/** Read-only helper so callers do not repeat the scope comparison. */
export const isArchivedScope = (): boolean => useAgentsListStore.getState().scope === 'archived';
