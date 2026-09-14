import { create } from 'zustand';

interface IssueSelectionState {
   selected: string[];
   /** Last task clicked without shift; the far end of a shift-range. */
   anchor: string | null;
   toggle: (id: string) => void;
   /** Adds everything between the anchor and `id`, in the order shown. */
   selectRange: (id: string, order: string[]) => void;
   setAll: (ids: string[]) => void;
   clear: () => void;
}

/** Tasks picked for a batch change. Not persisted: a selection is momentary. */
export const useIssueSelectionStore = create<IssueSelectionState>((set) => ({
   selected: [],
   anchor: null,
   toggle: (id) =>
      set((state) => ({
         selected: state.selected.includes(id)
            ? state.selected.filter((entry) => entry !== id)
            : [...state.selected, id],
         anchor: id,
      })),
   selectRange: (id, order) =>
      set((state) => {
         const from = state.anchor ? order.indexOf(state.anchor) : -1;
         const to = order.indexOf(id);
         // Without a usable anchor a shift-click is just a click: guessing a
         // range from one end would select things nobody pointed at.
         if (from === -1 || to === -1) {
            return {
               selected: state.selected.includes(id) ? state.selected : [...state.selected, id],
               anchor: id,
            };
         }
         const [start, end] = from <= to ? [from, to] : [to, from];
         const range = order.slice(start, end + 1);
         return {
            selected: [...new Set([...state.selected, ...range])],
            anchor: state.anchor,
         };
      }),
   setAll: (ids) => set({ selected: ids, anchor: ids.at(-1) ?? null }),
   clear: () => set({ selected: [], anchor: null }),
}));
