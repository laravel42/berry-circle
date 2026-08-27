import { create } from 'zustand';

/**
 * Whether the notifications drawer is open.
 *
 * Its own store rather than a flag on the notifications store: what is in the
 * inbox and whether a person is looking at it are unrelated, and the list is
 * hydrated from the workspace stream whether or not the drawer is on screen.
 */
interface NotificationsDrawerState {
   isOpen: boolean;
   open: () => void;
   close: () => void;
   toggle: () => void;
}

export const useNotificationsDrawerStore = create<NotificationsDrawerState>((set) => ({
   isOpen: false,
   open: () => set({ isOpen: true }),
   close: () => set({ isOpen: false }),
   toggle: () => set((state) => ({ isOpen: !state.isOpen })),
}));
