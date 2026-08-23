import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ShellRoute } from '@/components/layout/shell/shell-routes';

/**
 * Shell chrome state: which tabs are open and whether the rail is expanded.
 *
 * Ported from `Berry Prototype.dc.html`, which models the workspace as browser
 * tabs. Two behaviours from the prototype are load-bearing and easy to lose:
 *
 *   - visiting a route opens a tab for it if one is not already open, so tabs
 *     accumulate as you navigate rather than needing to be created; and
 *   - closing the active tab activates its left neighbour, not the first tab,
 *     so closing several in a row walks leftward the way a browser does.
 */
interface ShellState {
   tabs: ShellRoute[];
   railOpen: boolean;
   openTab: (route: ShellRoute) => void;
   /** Returns the route to navigate to after closing, or null to stay put. */
   closeTab: (route: ShellRoute, active: ShellRoute | null) => ShellRoute | null;
   toggleRail: () => void;
}

const DEFAULT_TABS: ShellRoute[] = ['issues', 'runs', 'reviews', 'inbox'];

export const useShellStore = create<ShellState>()(
   persist(
      (set, get) => ({
         tabs: DEFAULT_TABS,
         railOpen: true,

         openTab: (route) =>
            set((state) =>
               state.tabs.includes(route) ? state : { tabs: [...state.tabs, route] },
            ),

         closeTab: (route, active) => {
            const { tabs } = get();
            const index = tabs.indexOf(route);
            const remaining = tabs.filter((tab) => tab !== route);
            set({ tabs: remaining });

            // Closing a background tab must not move the user.
            if (active !== route) return null;
            return remaining[Math.max(0, index - 1)] ?? null;
         },

         toggleRail: () => set((state) => ({ railOpen: !state.railOpen })),
      }),
      {
         name: 'berry.shell',
         // Only chrome layout is persisted. Nothing here is product state, so
         // a cleared store costs the user a tab arrangement and nothing more.
         partialize: (state) => ({ tabs: state.tabs, railOpen: state.railOpen }),
      },
   ),
);
