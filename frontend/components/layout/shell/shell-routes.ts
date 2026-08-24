/**
 * Shell route table, ported from `Berry Prototype.dc.html`.
 *
 * The prototype distinguishes a route's identifier from its label — `members`
 * renders as "agents" — so both are kept here rather than derived. Deriving one
 * from the other would quietly rename a route the next time a label changes.
 */

import type { SidebarItemKey } from '@/store/sidebar-prefs-store';

export type ShellRoute =
   'issues' | 'runs' | 'reviews' | 'chat' | 'meetings' | 'inbox' | 'projects' | 'members';

export interface ShellRouteDef {
   /** Stable identifier, also the tab key. */
   id: ShellRoute;
   /** What the sidebar and tab strip display. */
   label: string;
   /** Inner SVG markup, drawn on a 24x24 viewBox with currentColor stroke. */
   icon: string;
   /** Route this navigates to, relative to the workspace. */
   href: string;
   /**
    * Key in the sidebar preference store, when the user can pin or hide this
    * item. Workspace routes are pinnable; primary routes are not.
    */
   prefsKey?: SidebarItemKey;
}

const PRIMARY: ShellRouteDef[] = [
   {
      id: 'inbox',
      label: 'inbox',
      href: '/inbox',
      icon: '<path d="M4 13l2.2-7.4A1 1 0 017.2 5h9.6a1 1 0 01.96.7L20 13" /><path d="M4 13h4.5l1.5 2.2h4l1.5-2.2H20v4a2 2 0 01-2 2H6a2 2 0 01-2-2z" />',
   },
   {
      id: 'issues',
      label: 'issues',
      href: '/my-issues',
      icon: '<path d="M4 7a2 2 0 012-2h4l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H6a2 2 0 01-2-2z" />',
   },
   {
      id: 'runs',
      label: 'runs',
      href: '/runs',
      icon: '<path d="M3 12h3l2-6 3 12 3-8 2 2h5" />',
   },
   {
      id: 'reviews',
      label: 'reviews',
      href: '/reviews',
      icon: '<circle cx="7" cy="6" r="2" /><circle cx="7" cy="18" r="2" /><circle cx="17" cy="12" r="2" /><path d="M7 8v8M9 18h4a2 2 0 002-2v-2" />',
   },
   {
      id: 'chat',
      label: 'chat',
      href: '/chat',
      icon: '<path d="M4 5h16v10H9l-5 4z" />',
   },
   {
      id: 'meetings',
      label: 'meetings',
      href: '/meetings',
      icon: '<rect x="3" y="7" width="12" height="10" rx="2" /><path d="M15 11l6-3v8l-6-3z" />',
   },
];

const WORKSPACE: ShellRouteDef[] = [
   {
      id: 'projects',
      label: 'projects',
      href: '/projects',
      prefsKey: 'projects',
      icon: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" /><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" />',
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

export const SHELL_SECTIONS: { heading: string | null; routes: ShellRouteDef[] }[] = [
   { heading: null, routes: PRIMARY },
   { heading: 'Workspace', routes: WORKSPACE },
];

const BY_ID = new Map<string, ShellRouteDef>(
   [...PRIMARY, ...WORKSPACE].map((route) => [route.id, route])
);

export function shellRoute(id: string): ShellRouteDef | undefined {
   return BY_ID.get(id);
}

/**
 * Resolve the active route from a pathname.
 *
 * Longest match wins so `/projects/abc` resolves to `projects` rather than
 * matching a shorter unrelated prefix.
 */
export function activeShellRoute(pathname: string): ShellRoute | null {
   let match: ShellRouteDef | null = null;
   for (const route of BY_ID.values()) {
      if (pathname.includes(route.href) && (!match || route.href.length > match.href.length)) {
         match = route;
      }
   }
   return match?.id ?? null;
}
