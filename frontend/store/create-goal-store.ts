import { create } from 'zustand';

export interface CreateGoalPrefill {
   title?: string;
   projectId?: string;
}

interface CreateGoalState {
   isOpen: boolean;
   prefill: CreateGoalPrefill;
   openModal: (prefill?: CreateGoalPrefill) => void;
   closeModal: () => void;
}

export const useCreateGoalStore = create<CreateGoalState>((set) => ({
   isOpen: false,
   prefill: {},
   openModal: (prefill = {}) => set({ isOpen: true, prefill }),
   closeModal: () => set({ isOpen: false }),
}));
