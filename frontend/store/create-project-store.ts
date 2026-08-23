import type { Status } from '@/data/status';
import { create } from 'zustand';

interface CreateProjectState {
   isOpen: boolean;
   defaultStatus: Status | null;
   openModal: (status?: Status) => void;
   closeModal: () => void;
}

export const useCreateProjectStore = create<CreateProjectState>((set) => ({
   isOpen: false,
   defaultStatus: null,
   openModal: (status) => set({ isOpen: true, defaultStatus: status ?? null }),
   closeModal: () => set({ isOpen: false, defaultStatus: null }),
}));
