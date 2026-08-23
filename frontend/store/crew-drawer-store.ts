import { create } from 'zustand';

interface CrewDrawerState {
   teamId: string | null;
   open: (teamId: string) => void;
   close: () => void;
}

export const useCrewDrawerStore = create<CrewDrawerState>((set) => ({
   teamId: null,
   open: (teamId) => set({ teamId }),
   close: () => set({ teamId: null }),
}));
