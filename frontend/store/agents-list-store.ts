import { create } from 'zustand';

export type AgentsSort = 'last-active-desc' | 'name-asc';

interface AgentsListState {
   search: string;
   sort: AgentsSort;
   setSearch: (search: string) => void;
   setSort: (sort: AgentsSort) => void;
}

export const useAgentsListStore = create<AgentsListState>((set) => ({
   search: '',
   sort: 'last-active-desc',
   setSearch: (search) => set({ search }),
   setSort: (sort) => set({ sort }),
}));
