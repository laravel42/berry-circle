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
   | 'goals'
   | 'autopilot'
   | 'approvals'
   | 'analytics'
   | 'agent'
   | 'initiatives'
   | 'projects'
   | 'views'
   | 'agents';

export type SidebarSection = 'personal' | 'workspace' | 'automate' | 'configure';

interface SidebarPrefsState {
   badgeStyle: SidebarBadgeStyle;
   visibility: Record<SidebarItemKey, SidebarVisibility>;
   /** Item order per section (drag & drop in the Customize sidebar modal). */
   order: Record<SidebarSection, SidebarItemKey[]>;
   setBadgeStyle: (style: SidebarBadgeStyle) => void;
   setVisibility: (item: SidebarItemKey, visibility: SidebarVisibility) => void;
   moveItem: (section: SidebarSection, from: number, to: number) => void;
}

/**
 * Everything shows. Nothing is hidden by default — a person who wants a
 * shorter rail can hide an item in "Customize sidebar", but the product does
 * not decide that for them, and an item nobody can find is not a feature.
 */
const DEFAULT_VISIBILITY: Record<SidebarItemKey, SidebarVisibility> = {
   'inbox': 'always',
   'reviews': 'always',
   'chat': 'always',
   'meetings': 'always',
   'my-issues': 'always',
   'goals': 'always',
   'autopilot': 'always',
   'approvals': 'always',
   'analytics': 'always',
   'agent': 'always',
   'initiatives': 'always',
   'projects': 'always',
   'views': 'always',
   'agents': 'always',
};

/**
 * "Customize sidebar" preferences: default badge style and per-item
 * visibility (always / show when badged / don't show). Persisted so the
 * sidebar keeps its shape across sessions.
 */
const DEFAULT_ORDER: Record<SidebarSection, SidebarItemKey[]> = {
   personal: [],
   // Goals sits under projects because that is where a goal comes from: it
   // groups the tasks one plan compiled inside a project.
   workspace: ['projects', 'goals', 'my-issues', 'reviews'],
   automate: [],
   configure: ['agent', 'agents', 'autopilot', 'analytics'],
};

/** The key the previous shape was persisted under; read once, when v6 has nothing. */
const PREVIOUS_STORAGE_KEY = 'sidebar-prefs-v5';

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

/**
 * The v3 preferences, when a person had customised them before the rail
 * grew its Automate section. Their visibility and order carry over; the
 * `automate` order is seeded from defaults, and `autopilot` leaves the
 * workspace list through `resolveOrder`, which only keeps a section's own
 * keys.
 */
type StoredPrefs = Omit<Partial<SidebarPrefsState>, 'visibility'> & {
   visibility?: Partial<Record<SidebarItemKey, SidebarVisibility>>;
};

function previousPrefs(): StoredPrefs | undefined {
   if (typeof window === 'undefined') return undefined;
   try {
      const raw = window.localStorage.getItem(PREVIOUS_STORAGE_KEY);
      if (!raw) return undefined;
      const parsed = JSON.parse(raw) as { state?: Partial<SidebarPrefsState> };
      const state = parsed.state;
      if (!state) return undefined;
      // Shape is not carried over. A stored preference beats a new default
      // forever, and every v5 browser stored the old order and the two hidden
      // items — so v6 would never show what it now says it shows. Only choices
      // that are not about which items appear survive the upgrade; what the
      // person does after this persists normally.
      const carried: StoredPrefs = { ...state };
      delete carried.visibility;
      delete carried.order;
      return carried;
   } catch {
      return undefined;
   }
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
         name: 'sidebar-prefs-v6',
         merge: (persisted, current) => {
            const stored = (persisted as StoredPrefs | undefined) ?? previousPrefs();
            const mergedOrder = { ...current.order, ...stored?.order };
            return {
               ...current,
               ...stored,
               visibility: { ...current.visibility, ...stored?.visibility },
               order: {
                  personal: resolveOrder(mergedOrder.personal, DEFAULT_ORDER.personal),
                  workspace: resolveOrder(mergedOrder.workspace, DEFAULT_ORDER.workspace),
                  automate: resolveOrder(mergedOrder.automate, DEFAULT_ORDER.automate),
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
