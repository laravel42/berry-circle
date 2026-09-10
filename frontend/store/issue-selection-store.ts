import { create } from 'zustand';

interface IssueSelectionState {
   selected: string[];
   toggle: (id: string) => void;
   clear: () => void;
   setAll: (ids: string[]) => void;
}

/** Tasks picked for a batch change. Not persisted: a selection is momentary. */
export const useIssueSelectionStore = create<IssueSelectionState>((set) => ({
   selected: [],
   toggle: (id) =>
      set((state) => ({
         selected: state.selected.includes(id) ? state.selected.filter((entry) => entry !== id) : [...state.selected, id],
      })),
   clear: () => set({ selected: [] }),
   setAll: (ids) => set({ selected: ids }),
}));
