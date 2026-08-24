import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ShellTab } from '@/components/layout/shell/shell-tab-model';

/**
 * Shell chrome: which tabs are open, and whether the rail is expanded.
 *
 * Ported from `Berry Prototype.dc.html`, which models the workspace as browser
 * tabs. Three behaviours from the prototype are load-bearing and easy to lose:
 *
 *   - visiting a route opens a tab for it if one is not already open, so tabs
 *     accumulate as you navigate rather than needing to be created;
 *   - closing the active tab activates its left neighbour, not the first tab,
 *     so closing several in a row walks leftward the way a browser does; and
 *   - closing a background tab does not move the user at all.
 */
interface ShellState {
   tabs: ShellTab[];
   railOpen: boolean;
   openTab: (tab: ShellTab) => void;
   /** Returns the tab to navigate to after closing, or null to stay put. */
   closeTab: (key: string, activeKey: string | null) => ShellTab | null;
   toggleRail: () => void;
}

const DEFAULT_TABS: ShellTab[] = [
   { key: 'issues', label: 'issues', href: '/my-issues' },
   { key: 'runs', label: 'runs', href: '/runs' },
   { key: 'reviews', label: 'reviews', href: '/reviews' },
   { key: 'inbox', label: 'inbox', href: '/inbox' },
];

/** Bounds the strip so a long session cannot grow it without limit. */
const MAX_TABS = 12;

export const useShellStore = create<ShellState>()(
   persist(
      (set, get) => ({
         tabs: DEFAULT_TABS,
         railOpen: true,

         openTab: (tab) =>
            set((state) => {
               const existing = state.tabs.find((open) => open.key === tab.key);
               // Re-visiting refreshes the label — an issue's title can change
               // while its tab is open — without reordering the strip.
               if (existing) {
                  if (existing.label === tab.label) return state;
                  return {
                     tabs: state.tabs.map((open) =>
                        open.key === tab.key ? { ...open, label: tab.label } : open,
                     ),
                  };
               }
               const next = [...state.tabs, tab];
               // Evict from the left, which is the least recently opened.
               return { tabs: next.length > MAX_TABS ? next.slice(next.length - MAX_TABS) : next };
            }),

         closeTab: (key, activeKey) => {
            const { tabs } = get();
            const index = tabs.findIndex((tab) => tab.key === key);
            if (index === -1) return null;
            const remaining = tabs.filter((tab) => tab.key !== key);
            set({ tabs: remaining });

            // Closing a background tab must not move the user.
            if (activeKey !== key) return null;
            return remaining[Math.max(0, index - 1)] ?? null;
         },

         toggleRail: () => set((state) => ({ railOpen: !state.railOpen })),
      }),
      {
         name: 'berry.shell',
         version: 2,
         // v1 stored bare route ids. Rather than migrate shapes, drop back to
         // defaults: a tab arrangement is cheap to rebuild and stale entries
         // would point at hrefs the new model cannot describe.
         migrate: () => ({ tabs: DEFAULT_TABS, railOpen: true }),
         partialize: (state) => ({ tabs: state.tabs, railOpen: state.railOpen }),
      },
   ),
);
