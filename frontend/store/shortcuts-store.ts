import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { normalizeCombo, resolveBindings } from '@/lib/shortcuts';

/**
 * A person's keyboard remappings.
 *
 * Only the differences from the defaults are stored, so a default that changes
 * later reaches everyone who never touched that row. A stored `null` is not
 * "no opinion": it is a shortcut the person switched off, which is why the
 * resolver checks for the key rather than for a value.
 *
 * The browser is the right home for this. It is a preference about this
 * keyboard, it must be readable synchronously on the first keystroke after a
 * page load, and nothing on the server needs to know it.
 */
interface ShortcutsState {
   /** Action id → combination, or null for "switched off". */
   overrides: Record<string, string | null>;
   setBinding: (id: string, combo: string) => void;
   /** Switch an action off without forgetting that the person chose to. */
   disable: (id: string) => void;
   /** Back to the shipped default for one action. */
   reset: (id: string) => void;
   /** Back to the shipped defaults for every action. */
   resetAll: () => void;
}

export const useShortcutsStore = create<ShortcutsState>()(
   persist(
      (set) => ({
         overrides: {},
         setBinding: (id, combo) =>
            set((state) => ({ overrides: { ...state.overrides, [id]: normalizeCombo(combo) } })),
         disable: (id) => set((state) => ({ overrides: { ...state.overrides, [id]: null } })),
         reset: (id) =>
            set((state) => {
               const overrides = { ...state.overrides };
               delete overrides[id];
               return { overrides };
            }),
         resetAll: () => set({ overrides: {} }),
      }),
      { name: 'berry.shortcuts', version: 1 }
   )
);

/** Every action's current combination: defaults with this person's edits on top. */
export function useShortcutBindings(): Record<string, string | null> {
   const overrides = useShortcutsStore((state) => state.overrides);
   return resolveBindings(overrides);
}
