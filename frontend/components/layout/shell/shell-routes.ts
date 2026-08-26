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
   | 'meetings'
   | 'inbox'
   | 'projects'
   | 'goals'
   | 'members'
   | 'autopilot'
   | 'workflow-runs'
   | 'approvals'
   | 'analytics';

export interface ShellRouteDef {
   /** Stable identifier, also the tab key. */
   id: ShellRoute;
   /** What the sidebar and tab strip display. */
   label: string;
   /** Inner SVG markup, drawn on a 24x24 viewBox with currentColor stroke. */
   icon: string;
   /**
    * Route this navigates to, relative to the workspace. Omitted for rail
    * placeholders that have no page yet.
    */
   href?: string;
   /**
    * Extra pathname fragments that count as this route being active, for the
    * singular detail paths that hang off a plural list (`/workflow/…` under
    * `/workflows`). Matched with the same longest-match rule as `href`.
    */
   match?: string[];
   /**
    * Key in the sidebar preference store, when the user can pin or hide this
    * item. Every rail destination is pinnable.
    */
   prefsKey?: SidebarItemKey;
}

const PRIMARY: ShellRouteDef[] = [
   {
      id: 'inbox',
      label: 'inbox',
      href: '/inbox',
      prefsKey: 'inbox',
      icon: '<path d="M4 13l2.2-7.4A1 1 0 017.2 5h9.6a1 1 0 01.96.7L20 13" /><path d="M4 13h4.5l1.5 2.2h4l1.5-2.2H20v4a2 2 0 01-2 2H6a2 2 0 01-2-2z" />',
   },
   {
      id: 'reviews',
      label: 'reviews',
      href: '/reviews',
      prefsKey: 'reviews',
      icon: '<circle cx="7" cy="6" r="2" /><circle cx="7" cy="18" r="2" /><circle cx="17" cy="12" r="2" /><path d="M7 8v8M9 18h4a2 2 0 002-2v-2" />',
   },
   {
      id: 'chat',
      label: 'chat',
      href: '/chat',
      prefsKey: 'chat',
      icon: '<path d="M4 5h16v10H9l-5 4z" />',
   },
   {
      id: 'meetings',
      label: 'meetings',
      href: '/meetings',
      prefsKey: 'meetings',
      icon: '<rect x="3" y="7" width="12" height="10" rx="2" /><path d="M15 11l6-3v8l-6-3z" />',
   },
];

const WORK: ShellRouteDef[] = [
   {
      id: 'issues',
      label: 'tasks',
      href: '/my-issues',
      prefsKey: 'my-issues',
      icon: '<path d="M4 7a2 2 0 012-2h4l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H6a2 2 0 01-2-2z" />',
   },
   {
      id: 'goals',
      label: 'goals',
      href: '/goals',
      match: ['/goal/', '/plan/'],
      prefsKey: 'goals',
      icon: '<circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4.5" /><circle cx="12" cy="12" r="1" />',
   },
   {
      id: 'analytics',
      label: 'analytics',
      prefsKey: 'analytics',
      icon: '<path d="M4 19V10M10 19V5M16 19v-7" /><path d="M3 19h18" />',
   },
   {
      id: 'projects',
      label: 'projects',
      href: '/projects',
      match: ['/project/'],
      prefsKey: 'projects',
      icon: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" /><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" />',
   },
];

const AUTOMATE: ShellRouteDef[] = [
   {
      // The id and prefs key predate the page: persisted preferences survive.
      id: 'autopilot',
      label: 'automations',
      href: '/workflows',
      match: ['/workflow/', '/workflows'],
      prefsKey: 'autopilot',
      icon: '<path d="M20 8a8 8 0 10-2.2 6.4" /><path d="M20 4v5h-5" />',
   },
   {
      id: 'workflow-runs',
      label: 'runs',
      href: '/workflow-runs',
      match: ['/workflow-run/'],
      prefsKey: 'workflow-runs',
      icon: '<path d="M4 6h16M4 12h16M4 18h9" /><path d="M16 16l3 2-3 2z" />',
   },
   {
      id: 'approvals',
      label: 'approvals',
      href: '/approvals',
      prefsKey: 'approvals',
      icon: '<path d="M12 3l8 3v6c0 4.6-3.4 8.3-8 9-4.6-.7-8-4.4-8-9V6z" /><path d="M9 12l2 2 4-4" />',
   },
];

const MANAGE: ShellRouteDef[] = [
   {
      id: 'runs',
      label: 'runtimes',
      href: '/runs',
      prefsKey: 'agent',
      icon: '<path d="M3 12h3l2-6 3 12 3-8 2 2h5" />',
   },
   {
      id: 'members',
      label: 'agents',
      href: '/agents',
      prefsKey: 'agents',
      icon: '<path d="M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8z" /><path d="M18 16l.9 2.1L21 19l-2.1.9L18 22l-.9-2.1L15 19l2.1-.9z" />',
   },
];

export const MORE_ICON =
   '<circle cx="6" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="18" cy="12" r="1.4" />';

export const SHELL_SECTIONS: {
   heading: string | null;
   routes: ShellRouteDef[];
   prefsSection?: SidebarSection;
}[] = [
   { heading: null, routes: PRIMARY, prefsSection: 'personal' },
   { heading: 'Work', routes: WORK, prefsSection: 'workspace' },
   { heading: 'Automate', routes: AUTOMATE, prefsSection: 'automate' },
   { heading: 'Manage', routes: MANAGE, prefsSection: 'configure' },
];

const BY_ID = new Map<string, ShellRouteDef>(
   [...PRIMARY, ...WORK, ...AUTOMATE, ...MANAGE].map((route) => [route.id, route])
);

export function shellRoute(id: string): ShellRouteDef | undefined {
   return BY_ID.get(id);
}

/**
 * Resolve the active route from a pathname.
 *
 * Longest match wins so `/projects/abc` resolves to `projects` rather than
 * matching a shorter unrelated prefix, and a detail path such as
 * `/workflow/abc/history` lights up its list item through `match` without
 * `/runs` ever being part of it — `pathname.includes` would otherwise hand
 * a workflow's run history to the runtimes item.
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
