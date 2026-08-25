import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type SidebarVisibility = 'always' | 'badged' | 'never';
export type SidebarBadgeStyle = 'count' | 'dot';

export type SidebarItemKey =
   | 'inbox'
   | 'reviews'
   | 'chat'
   | 'meetings'
   | 'my-issues'
   | 'autopilot'
   | 'analytics'
   | 'agent'
   | 'initiatives'
   | 'projects'
   | 'views'
   | 'agents';

export type SidebarSection = 'personal' | 'workspace' | 'configure';

interface SidebarPrefsState {
   badgeStyle: SidebarBadgeStyle;
   visibility: Record<SidebarItemKey, SidebarVisibility>;
   /** Item order per section (drag & drop in the Customize sidebar modal). */
   order: Record<SidebarSection, SidebarItemKey[]>;
   setBadgeStyle: (style: SidebarBadgeStyle) => void;
   setVisibility: (item: SidebarItemKey, visibility: SidebarVisibility) => void;
   moveItem: (section: SidebarSection, from: number, to: number) => void;
}

const DEFAULT_VISIBILITY: Record<SidebarItemKey, SidebarVisibility> = {
   inbox: 'always',
   reviews: 'always',
   chat: 'always',
   meetings: 'always',
   'my-issues': 'always',
   autopilot: 'always',
   analytics: 'always',
   agent: 'always',
   initiatives: 'never',
   projects: 'never',
   views: 'never',
   agents: 'always',
};

/**
 * "Customize sidebar" preferences: default badge style and per-item
 * visibility (always / show when badged / don't show). Persisted so the
 * sidebar keeps its shape across sessions.
 */
const DEFAULT_ORDER: Record<SidebarSection, SidebarItemKey[]> = {
   personal: ['inbox', 'reviews', 'chat', 'meetings'],
   workspace: ['my-issues', 'autopilot', 'analytics', 'projects'],
   configure: ['agent', 'agents'],
};

/**
 * Stored order, resilient to new items: unknown keys are dropped, missing
 * defaults are inserted after their default predecessor.
 */
export function resolveOrder(
   stored: SidebarItemKey[] | undefined,
   defaults: SidebarItemKey[]
): SidebarItemKey[] {
   const result = (stored ?? []).filter((key) => defaults.includes(key));
   defaults.forEach((key, index) => {
      if (result.includes(key)) return;
      let insertAt = 0;
      for (let i = index - 1; i >= 0; i--) {
         const position = result.indexOf(defaults[i]);
         if (position !== -1) {
            insertAt = position + 1;
            break;
         }
      }
      result.splice(insertAt, 0, key);
   });
   return result;
}

export const useSidebarPrefsStore = create<SidebarPrefsState>()(
   persist(
      (set) => ({
         badgeStyle: 'count',
         visibility: DEFAULT_VISIBILITY,
         order: DEFAULT_ORDER,
         setBadgeStyle: (badgeStyle) => set({ badgeStyle }),
         setVisibility: (item, value) =>
            set((state) => ({ visibility: { ...state.visibility, [item]: value } })),
         moveItem: (section, from, to) =>
            set((state) => {
               const keys = resolveOrder(state.order[section], DEFAULT_ORDER[section]);
               if (from < 0 || from >= keys.length || to < 0 || to >= keys.length) return state;
               const [moved] = keys.splice(from, 1);
               keys.splice(to, 0, moved);
               return { order: { ...state.order, [section]: keys } };
            }),
      }),
      {
         name: 'sidebar-prefs-v3',
         merge: (persisted, current) => {
            const stored = persisted as Partial<SidebarPrefsState> | undefined;
            const mergedOrder = { ...current.order, ...stored?.order };
            return {
               ...current,
               ...stored,
               visibility: { ...current.visibility, ...stored?.visibility },
               order: {
                  personal: resolveOrder(mergedOrder.personal, DEFAULT_ORDER.personal),
                  workspace: resolveOrder(mergedOrder.workspace, DEFAULT_ORDER.workspace),
                  configure: resolveOrder(mergedOrder.configure, DEFAULT_ORDER.configure),
               },
            };
         },
      }
   )
);

/**
 * Should an item be rendered, given its visibility pref and badge count?
 * A missing pref (item added after the prefs were persisted) counts as
 * "always" so new sidebar entries show up by default.
 */
export function isSidebarItemVisible(
   visibility: SidebarVisibility | undefined,
   badgeCount: number
): boolean {
   if (!visibility || visibility === 'always') return true;
   if (visibility === 'badged') return badgeCount > 0;
   return false;
}
