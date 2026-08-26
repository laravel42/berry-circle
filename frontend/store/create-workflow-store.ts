import { create } from 'zustand';

/** What a caller can pre-fill when opening the New workflow dialog. */
export interface CreateWorkflowPrefill {
   name?: string;
   goalId?: string;
   projectId?: string;
}

interface CreateWorkflowState {
   isOpen: boolean;
   prefill: CreateWorkflowPrefill;
   openModal: (prefill?: CreateWorkflowPrefill) => void;
   closeModal: () => void;
}

export const useCreateWorkflowStore = create<CreateWorkflowState>((set) => ({
   isOpen: false,
   prefill: {},
   openModal: (prefill = {}) => set({ isOpen: true, prefill }),
   closeModal: () => set({ isOpen: false }),
}));
