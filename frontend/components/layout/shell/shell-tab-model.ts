import { shellRoute, SHELL_SECTIONS } from './shell-routes';

/**
 * A tab is any route the user has visited, not only a nav destination.
 *
 * `Berry Prototype.dc.html` makes this explicit: its tab list holds `inbox`,
 * which has no rail entry, alongside `reviewsCreated` ("reviews / created") and
 * `issue404` ("BERRY-404"). Modelling tabs as a closed set of nav ids cannot
 * represent any of those, so a tab carries its own label and href instead.
 */
export interface ShellTab {
   /** Stable identity, derived from the workspace-relative path. */
   key: string;
   label: string;
   href: string;
}

/** Section labels that differ from their path segment, per the prototype. */
const SECTION_LABELS: Record<string, string> = {
   'my-issues': 'issues',
   issue: 'issues',
   teams: 'crews',
   team: 'crews',
   agents: 'agents',
   members: 'agents',
   agent: 'agents',
   project: 'projects',
   initiative: 'initiatives',
   review: 'reviews',
   view: 'views',
};

/** Looks like an issue key (BERRY-404), which the prototype shows verbatim. */
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
export function describeTab(pathname: string, orgId: string): ShellTab | null {
   const relative = workspaceRelative(pathname, orgId);
   if (!relative || relative === '/') return null;
   if (relative.startsWith('/settings')) return null;

   // A rail destination keeps its rail label, so "crews" reads the same in both.
   const nav = SHELL_SECTIONS.flatMap((section) => section.routes).find(
      (route) => route.href === relative,
   );
   if (nav) return { key: nav.id, label: nav.label, href: relative };

   const segments = relative.split('/').filter(Boolean);
   if (segments.length === 0) return null;

   const [section, ...rest] = segments;
   const sectionLabel = SECTION_LABELS[section] ?? section;
   if (rest.length === 0) {
      return { key: relative, label: sectionLabel, href: relative };
   }

   // An issue key identifies itself; anything else reads as "section / detail".
   const detail = rest[rest.length - 1];
   const label = ISSUE_KEY.test(detail)
      ? detail.toUpperCase()
      : `${sectionLabel} / ${detail}`;

   return { key: relative, label, href: relative };
}

/** The rail route a tab belongs to, for highlighting while a detail is open. */
export function tabSection(tab: ShellTab): string | null {
   const nav = shellRoute(tab.key);
   if (nav) return nav.id;
   const section = tab.href.split('/').filter(Boolean)[0];
   return section ? (SECTION_LABELS[section] ?? section) : null;
}
