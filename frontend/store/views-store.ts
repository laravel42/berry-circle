import type { View } from '@/data/views';
import { create } from 'zustand';

interface ViewsState {
   views: View[];
   hydrateViews: (views: View[]) => void;
   getViewById: (id: string) => View | undefined;
}

export const useViewsStore = create<ViewsState>((set, get) => ({
   views: [],

   hydrateViews: (views) => set({ views }),

   getViewById: (id) => get().views.find((view) => view.id === id),
}));
