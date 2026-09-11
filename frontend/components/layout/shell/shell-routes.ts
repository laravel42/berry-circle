/**
 * Shell route table, ported from `Berry Prototype.dc.html`.
 *
 * The prototype distinguishes a route's identifier from its label — `members`
 * renders as "agents" — so both are kept here rather than derived. Deriving one
 * from the other would quietly rename a route the next time a label changes.
 */

import type { SidebarItemKey, SidebarSection } from '@/store/sidebar-prefs-store';

export type ShellRoute =
   | 'issues'
   | 'runs'
   | 'reviews'
   | 'chat'
   | 'inbox'
   | 'projects'
   | 'goals'
   | 'members'
   | 'skills'
   | 'squads'
   | 'autopilots'
   | 'dashboard'
   | 'usage';

/** Key under `shell.nav` in the message catalogues. */
export type ShellLabelKey =
   | 'tasks'
   | 'chat'
   | 'reviews'
   | 'goals'
   | 'projects'
   | 'runtimes'
   | 'agents'
   | 'analytics'
   | 'skills'
   | 'squads'
   | 'autopilots'
   | 'dashboard'
   | 'usage';

export interface ShellRouteDef {
   /** Stable identifier, also the tab key. */
   id: ShellRoute;
   /** What the sidebar and tab strip display. */
   label: string;
   /**
    * Catalogue key the rail and tabs render. `label` stays as the English
    * form for the persisted tab model, which runs outside React.
    */
   labelKey: ShellLabelKey;
   /** Inner SVG markup, drawn on a 24x24 viewBox with currentColor stroke. */
   icon: string;
   /**
    * Route this navigates to, relative to the workspace. Omitted for rail
    * placeholders that have no page yet.
    */
   href?: string;
   /**
    * Extra pathname fragments that count as this route being active, for the
    * singular detail paths that hang off a plural list (`/issue/…` under
    * `/my-issues`). Matched with the same longest-match rule as `href`.
    */
   match?: string[];
   /**
    * Key in the sidebar preference store, when the user can pin or hide this
    * item. Every rail destination is pinnable.
    */
   prefsKey?: SidebarItemKey;
   /**
    * Show a live dot on this item while something is running, the way the rail
    * marks runtimes. Declared here rather than matched on `id` in the rail so
    * the route table stays the one description of what a route is.
    */
   live?: 'runs';
}

const WORK: ShellRouteDef[] = [
   {
      id: 'issues',
      label: 'tasks',
      labelKey: 'tasks',
      href: '/my-issues',
      prefsKey: 'my-issues',
      icon: '<path d="M4 7a2 2 0 012-2h4l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H6a2 2 0 01-2-2z" />',
   },
   {
      id: 'reviews',
      label: 'reviews',
      labelKey: 'reviews',
      href: '/reviews',
      prefsKey: 'reviews',
      icon: '<circle cx="7" cy="6" r="2" /><circle cx="7" cy="18" r="2" /><circle cx="17" cy="12" r="2" /><path d="M7 8v8M9 18h4a2 2 0 002-2v-2" />',
   },
   {
      id: 'chat',
      label: 'chat',
      labelKey: 'chat',
      href: '/chat',
      prefsKey: 'chat',
      icon: '<path d="M4 5h16v11H9l-5 4z" />',
   },
   {
      id: 'goals',
      label: 'goals',
      labelKey: 'goals',
      href: '/goals',
      match: ['/goal/', '/plan/'],
      prefsKey: 'goals',
      icon: '<circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4.5" /><circle cx="12" cy="12" r="1" />',
   },
   {
      id: 'projects',
      label: 'projects',
      labelKey: 'projects',
      href: '/projects',
      match: ['/project/'],
      prefsKey: 'projects',
      icon: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" /><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" />',
   },
];

const MANAGE: ShellRouteDef[] = [
   {
      // The id stays `runs` because persisted tabs and sidebar prefs key on
      // it. The item opens the runtimes page; the run ledger it used to open
      // is still reached from runtime and agent detail and the command
      // palette, and `match` keeps the item lit while it is open.
      id: 'runs',
      label: 'runtimes',
      labelKey: 'runtimes',
      href: '/runtimes',
      match: ['/runtimes/', '/runs'],
      prefsKey: 'agent',
      live: 'runs',
      icon: '<path d="M3 12h3l2-6 3 12 3-8 2 2h5" />',
   },
   {
      id: 'members',
      label: 'agents',
      labelKey: 'agents',
      href: '/agents',
      prefsKey: 'agents',
      icon: '<path d="M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8z" /><path d="M18 16l.9 2.1L21 19l-2.1.9L18 22l-.9-2.1L15 19l2.1-.9z" />',
   },
   {
      id: 'skills',
      label: 'skills',
      labelKey: 'skills',
      href: '/skills',
      match: ['/skills/'],
      prefsKey: 'skills',
      icon: '<path d="M5 4h10a4 4 0 014 4v12H9a4 4 0 01-4-4z" /><path d="M9 8h6M9 12h6" />',
   },
   {
      id: 'squads',
      label: 'squads',
      labelKey: 'squads',
      href: '/squads',
      match: ['/squads/'],
      prefsKey: 'squads',
      icon: '<circle cx="9" cy="8" r="3" /><circle cx="17" cy="9" r="2.5" /><path d="M3 20a6 6 0 0112 0M14 20a4.5 4.5 0 017-3.5" />',
   },
   {
      id: 'autopilots',
      label: 'autopilots',
      labelKey: 'autopilots',
      href: '/autopilots',
      match: ['/autopilot/'],
      prefsKey: 'autopilot',
      icon: '<circle cx="12" cy="13" r="7.5" /><path d="M12 9v4l2.5 2.5" /><path d="M9.5 3h5" />',
   },
   {
      id: 'dashboard',
      label: 'dashboard',
      labelKey: 'dashboard',
      href: '/dashboard',
      prefsKey: 'dashboard',
      icon: '<rect x="4" y="4" width="7" height="9" rx="1" /><rect x="13" y="4" width="7" height="5" rx="1" /><rect x="13" y="11" width="7" height="9" rx="1" /><rect x="4" y="15" width="7" height="5" rx="1" />',
   },
   {
      id: 'usage',
      label: 'usage',
      labelKey: 'usage',
      href: '/usage',
      prefsKey: 'usage',
      icon: '<circle cx="12" cy="12" r="8.5" /><path d="M12 7v10M9.5 9.5c0-1 1-1.5 2.5-1.5s2.5.6 2.5 1.7c0 2.6-5 1.3-5 4 0 1.1 1 1.8 2.5 1.8s2.5-.5 2.5-1.5" />',
   },
];

export const MORE_ICON =
   '<circle cx="6" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="18" cy="12" r="1.4" />';

export const SHELL_SECTIONS: {
   heading: string | null;
   /** Key under `shell.sections`; null when the section has no heading. */
   headingKey: 'work' | 'manage' | null;
   routes: ShellRouteDef[];
   prefsSection?: SidebarSection;
}[] = [
   { heading: 'Work', headingKey: 'work', routes: WORK, prefsSection: 'workspace' },
   { heading: 'Manage', headingKey: 'manage', routes: MANAGE, prefsSection: 'configure' },
];

/** Every rail destination, for surfaces that label a path by its rail entry. */
export const SHELL_ROUTES: ShellRouteDef[] = [...WORK, ...MANAGE];

const BY_ID = new Map<string, ShellRouteDef>(
   [...WORK, ...MANAGE].map((route) => [route.id, route])
);

export function shellRoute(id: string): ShellRouteDef | undefined {
   return BY_ID.get(id);
}

/**
 * Resolve the active route from a pathname.
 *
 * Longest match wins so `/projects/abc` resolves to `projects` rather than
 * matching a shorter unrelated prefix, and a detail path such as
 * `/goal/abc/overview` lights up its list item through `match` rather than
 * through a bare `pathname.includes`, which would hand any path containing
 * a shorter route's name to the wrong item.
 */
export function activeShellRoute(pathname: string): ShellRoute | null {
   let match: ShellRouteDef | null = null;
   // Tracked beside the match: `href` is optional on the type, so comparing
   // against `match.href` would need a non-null assertion even though a match
   // is only ever a route that has one.
   let matchLength = 0;
   for (const route of BY_ID.values()) {
      if (!route.href) continue;
      for (const candidate of [route.href, ...(route.match ?? [])]) {
         if (pathname.includes(candidate) && candidate.length > matchLength) {
            match = route;
            matchLength = candidate.length;
         }
      }
   }
   return match?.id ?? null;
}
