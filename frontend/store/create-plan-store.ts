import { create } from 'zustand';

/** What a caller can pre-fill when opening the plan prompt. */
export interface CreatePlanPrefill {
   prompt?: string;
   goalId?: string;
   projectId?: string;
   hint?: 'issue' | 'auto';
}

interface CreatePlanState {
   isOpen: boolean;
   prefill: CreatePlanPrefill;
   openModal: (prefill?: CreatePlanPrefill) => void;
   closeModal: () => void;
}

export const useCreatePlanStore = create<CreatePlanState>((set) => ({
   isOpen: false,
   prefill: {},
   openModal: (prefill = {}) => set({ isOpen: true, prefill }),
   closeModal: () => set({ isOpen: false }),
}));
