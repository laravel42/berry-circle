import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** A tab is a container with its own identity; its route can change. */
export interface ShellTab {
   /** Stable for the tab's lifetime, independent of what it displays. */
   id: string;
   /** Workspace-relative path currently shown in this tab. */
   href: string;
   label: string;
}

/**
 * Shell chrome: open tabs, which one is active, and whether the rail is open.
 *
 * Modelled on a browser, which is what `Berry Prototype.dc.html` shows. The
 * important consequence is that a tab is *not* identified by its route:
 *
 *   - navigating changes what the active tab displays, it does not open a tab.
 *     That is what makes a rail click replace the current view rather than
 *     accumulate one tab per destination; and
 *   - two tabs may show the same route, so "+" can open a second copy of the
 *     index page the way a browser opens a second copy of your homepage.
 *
 * Identifying tabs by route made both impossible, because a route could only
 * ever appear once and a tab could never change what it pointed at.
 */
interface ShellState {
   tabs: ShellTab[];
   activeTabId: string | null;
   railOpen: boolean;
   /** Point the active tab at a route; used when the URL changes. */
   showInActiveTab: (href: string, label: string) => void;
   /** Open an additional tab and focus it, even if the route is already open. */
   openTab: (href: string, label: string) => void;
   activateTab: (id: string) => void;
   /** Returns the tab to navigate to after closing, or null to stay put. */
   closeTab: (id: string) => ShellTab | null;
   toggleRail: () => void;
}

/** The route a new tab starts on, matching the prototype's `startRoute`. */
export const INDEX_TAB = { href: '/tasks', label: 'tasks' };

/** Bounds the strip so a long session cannot grow it without limit. */
const MAX_TABS = 12;

function newId(): string {
   if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      return crypto.randomUUID();
   }
   return `tab-${Math.random().toString(36).slice(2)}`;
}

function seed(): { tabs: ShellTab[]; activeTabId: string } {
   const tab = { id: newId(), ...INDEX_TAB };
   return { tabs: [tab], activeTabId: tab.id };
}

export const useShellStore = create<ShellState>()(
   persist(
      (set, get) => ({
         ...seed(),
         railOpen: true,

         showInActiveTab: (href, label) =>
            set((state) => {
               const active = state.tabs.find((tab) => tab.id === state.activeTabId);
               // No tab to navigate within — adopt the route as the first one.
               if (!active) {
                  const tab = { id: newId(), href, label };
                  return { tabs: [...state.tabs, tab], activeTabId: tab.id };
               }
               if (active.href === href && active.label === label) return state;
               return {
                  tabs: state.tabs.map((tab) =>
                     tab.id === active.id ? { ...tab, href, label } : tab
                  ),
               };
            }),

         openTab: (href, label) =>
            set((state) => {
               const tab = { id: newId(), href, label };
               const next = [...state.tabs, tab];
               // Evict from the left, which is the least recently opened.
               return {
                  tabs: next.length > MAX_TABS ? next.slice(next.length - MAX_TABS) : next,
                  activeTabId: tab.id,
               };
            }),

         activateTab: (id) => set({ activeTabId: id }),

         closeTab: (id) => {
            const { tabs, activeTabId } = get();
            const index = tabs.findIndex((tab) => tab.id === id);
            if (index === -1) return null;
            const remaining = tabs.filter((tab) => tab.id !== id);

            // Closing a background tab must not move the user.
            if (activeTabId !== id) {
               set({ tabs: remaining });
               return null;
            }
            // Closing the active tab activates its left neighbour, so closing
            // several in a row walks leftward the way a browser does.
            const next = remaining[Math.max(0, index - 1)] ?? null;
            if (next) {
               set({ tabs: remaining, activeTabId: next.id });
               return next;
            }
            // Emptying the strip leaves a fresh index tab rather than nothing.
            const fresh = seed();
            set({ tabs: fresh.tabs, activeTabId: fresh.activeTabId });
            return fresh.tabs[0];
         },

         toggleRail: () => set((state) => ({ railOpen: !state.railOpen })),
      }),
      {
         name: 'berry.shell',
         version: 3,
         // Earlier versions keyed tabs by route and had no active-tab id, so a
         // stored strip cannot be mapped onto this model. A tab arrangement is
         // cheap to rebuild, so reset rather than migrate a shape that cannot
         // express the current one.
         migrate: () => ({ ...seed(), railOpen: true }),
         partialize: (state) => ({
            tabs: state.tabs,
            activeTabId: state.activeTabId,
            railOpen: state.railOpen,
         }),
      }
   )
);
