import type { Pin } from '@/lib/pins';
import { create } from 'zustand';

interface PinsState {
   pins: Pin[];
   loaded: boolean;
   hydrate: (pins: Pin[]) => void;
   add: (pin: Pin) => void;
   remove: (pinId: string) => void;
}

export const usePinsStore = create<PinsState>((set) => ({
   pins: [],
   loaded: false,
   hydrate: (pins) => set({ pins, loaded: true }),
   add: (pin) => set((state) => ({ pins: state.pins.some((entry) => entry.id === pin.id) ? state.pins : [...state.pins, pin] })),
   remove: (pinId) => set((state) => ({ pins: state.pins.filter((entry) => entry.id !== pinId) })),
}));
