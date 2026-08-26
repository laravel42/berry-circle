import { create } from 'zustand';

interface EventStreamState {
   /** True while the workspace stream is open; pages poll only when it is not. */
   connected: boolean;
   /** The last event id received, sent back as `after` on reconnect. */
   lastEventId: string | null;
   setConnected: (connected: boolean) => void;
   setLastEventId: (id: string) => void;
}

export const useEventStreamStore = create<EventStreamState>((set) => ({
   connected: false,
   lastEventId: null,
   setConnected: (connected) => set({ connected }),
   setLastEventId: (lastEventId) => set({ lastEventId }),
}));
