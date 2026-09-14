import type { Pin } from '@/lib/pins';
import { create } from 'zustand';

interface PinsState {
   pins: Pin[];
   loaded: boolean;
   hydrate: (pins: Pin[]) => void;
   add: (pin: Pin) => void;
   remove: (pinId: string) => void;
   /**
    * Move a pin within the list, for the optimistic half of a drag. The server
    * is told separately and answers with the authoritative order, which then
    * arrives through `hydrate` — so a failed reorder corrects itself on the
    * next load rather than leaving the rail lying about where things are.
    */
   move: (from: number, to: number) => void;
}

export const usePinsStore = create<PinsState>((set) => ({
   pins: [],
   loaded: false,
   hydrate: (pins) => set({ pins, loaded: true }),
   add: (pin) =>
      set((state) => ({
         pins: state.pins.some((entry) => entry.id === pin.id) ? state.pins : [...state.pins, pin],
      })),
   remove: (pinId) => set((state) => ({ pins: state.pins.filter((entry) => entry.id !== pinId) })),
   move: (from, to) =>
      set((state) => {
         if (from === to) return state;
         const pins = [...state.pins];
         if (from < 0 || from >= pins.length || to < 0 || to >= pins.length) return state;
         const [moved] = pins.splice(from, 1);
         pins.splice(to, 0, moved);
         return { pins };
      }),
}));
