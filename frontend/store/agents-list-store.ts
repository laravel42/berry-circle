import { create } from 'zustand';

export type AgentsTab = 'all' | 'mine' | 'archived';
export type AgentsSort = 'last-active-desc' | 'name-asc';

export interface AgentsTabCounts {
   all: number;
   mine: number;
   archived: number;
}

interface AgentsListState {
   search: string;
   tab: AgentsTab;
   sort: AgentsSort;
   tabCounts: AgentsTabCounts;
   setSearch: (search: string) => void;
   setTab: (tab: AgentsTab) => void;
   setSort: (sort: AgentsSort) => void;
   setTabCounts: (tabCounts: AgentsTabCounts) => void;
}

export const useAgentsListStore = create<AgentsListState>((set) => ({
   search: '',
   tab: 'all',
   sort: 'last-active-desc',
   tabCounts: { all: 0, mine: 0, archived: 0 },
   setSearch: (search) => set({ search }),
   setTab: (tab) => set({ tab }),
   setSort: (sort) => set({ sort }),
   setTabCounts: (tabCounts) => set({ tabCounts }),
}));
