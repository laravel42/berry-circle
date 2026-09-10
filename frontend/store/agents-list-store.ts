import { create } from 'zustand';

export type AgentsSort = 'last-active-desc' | 'name-asc';

interface AgentsListState {
   search: string;
   sort: AgentsSort;
   /** List archived agents instead of live ones. */
   showArchived: boolean;
   setSearch: (search: string) => void;
   setSort: (sort: AgentsSort) => void;
   setShowArchived: (showArchived: boolean) => void;
}

export const useAgentsListStore = create<AgentsListState>((set) => ({
   search: '',
   sort: 'last-active-desc',
   showArchived: false,
   setSearch: (search) => set({ search }),
   setSort: (sort) => set({ sort }),
   setShowArchived: (showArchived) => set({ showArchived }),
}));
