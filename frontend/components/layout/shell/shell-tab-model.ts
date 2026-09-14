import { SHELL_SECTIONS } from './shell-routes';

/**
 * What a route looks like when shown in a tab.
 *
 * Tabs hold detail routes (`reviewsCreated` -> "reviews / created", `issue404`
 * -> "BER-404") as well as rail destinations, so a label cannot be looked up
 * from the nav table alone.
 */
export interface RouteDescriptor {
   label: string;
   href: string;
}

/** Section labels that differ from their path segment, per the prototype. */
const SECTION_LABELS: Record<string, string> = {
   'tasks': 'tasks',
   // The route's old name; tabs persisted before the rename still carry it.
   'my-issues': 'tasks',
   'issue': 'tasks',
   'agents': 'agents',
   'members': 'agents',
   'runs': 'runs',
   'project': 'projects',
   'plan': 'plans',
   'goal': 'goals',
   'goals': 'goals',
   'approval': 'approvals',
   'approvals': 'approvals',
   'review': 'reviews',
   'view': 'views',
};

/** Looks like an issue key (BER-404), which the prototype shows verbatim. */
const ISSUE_KEY = /^[a-z][a-z0-9]*-\d+$/i;

/**
 * Strip the workspace prefix so tabs are portable between workspaces and two
 * paths differing only by org do not become two tabs.
 */
function workspaceRelative(pathname: string, orgId: string): string | null {
   const prefix = `/${orgId}`;
   if (pathname === prefix) return '/';
   if (!pathname.startsWith(`${prefix}/`)) return null;
   return pathname.slice(prefix.length);
}

/**
 * Describe the tab for a pathname, or null when the path is not tabbable.
 *
 * Settings is deliberately excluded: it is a modal destination reached from the
 * rail's help control, and tabbing it would leave a tab pointing at a surface
 * the user thinks they closed.
 */
export function describeRoute(pathname: string, orgId: string): RouteDescriptor | null {
   const relative = workspaceRelative(pathname, orgId);
   if (!relative || relative === '/') return null;
   if (relative.startsWith('/settings')) return null;

   // A rail destination keeps its rail label, so both surfaces read the same.
   const nav = SHELL_SECTIONS.flatMap((section) => section.routes).find(
      (route) => route.href && route.href === relative
   );
   if (nav) return { label: nav.label, href: relative };

   const segments = relative.split('/').filter(Boolean);
   if (segments.length === 0) return null;

   const [section, ...rest] = segments;
   const sectionLabel = SECTION_LABELS[section] ?? section;
   if (rest.length === 0) {
      return { label: sectionLabel, href: relative };
   }

   // An issue key identifies itself; anything else reads as "section / detail".
   const detail = rest[rest.length - 1];
   const label = ISSUE_KEY.test(detail) ? detail.toUpperCase() : `${sectionLabel} / ${detail}`;

   return { label, href: relative };
}
