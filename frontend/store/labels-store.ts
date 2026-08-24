import type { LabelInterface } from '@/data/labels';
import { create } from 'zustand';

interface LabelsState {
   labels: LabelInterface[];
   hydrateLabels: (labels: LabelInterface[]) => void;
   getLabelById: (id: string) => LabelInterface | undefined;
}

export const useLabelsStore = create<LabelsState>((set, get) => ({
   labels: [],

   hydrateLabels: (labels) => set({ labels }),

   getLabelById: (id) => get().labels.find((label) => label.id === id),
}));
