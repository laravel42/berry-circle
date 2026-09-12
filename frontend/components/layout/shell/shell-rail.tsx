'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { RiSettings3Line } from '@remixicon/react';
import { SquarePen } from 'lucide-react';
import {
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { CustomizeSidebarDialog } from '@/components/layout/sidebar/customize-sidebar-dialog';
import {
   isSidebarItemVisible,
   resolveOrder,
   useSidebarPrefsStore,
   type SidebarItemKey,
   type SidebarSection,
} from '@/store/sidebar-prefs-store';
import { isTerminalRunStatus } from '@/lib/runs';
import { useRunsStore } from '@/store/runs-store';
import { hasIssueDraft, useCreateIssueStore } from '@/store/create-issue-store';
import { useIsMobile } from '@/hooks/use-mobile';
import { SHELL_SECTIONS, type ShellRouteDef, type ShellRoute } from './shell-routes';
import { ShellIcon, BerryMark, shellIconButton } from './shell-icon';
import { WorkspaceMenuItems } from './workspace-menu';
import { ShellRailSettings } from './shell-rail-settings';
import { ShellPins } from './shell-pins';
import { ShellPersonal } from './shell-personal';
import { ShellHelp } from './shell-help';

/** A workspace route the user can pin or hide. */
type PinnableRoute = ShellRouteDef & { prefsKey: SidebarItemKey };

interface ShellRailProps {
   orgId: string;
   active: ShellRoute | null;
   onToggle: () => void;
   /** Settings replaces the rail's contents, as it did in AppSidebar. */
   settingsMode: boolean;
}

/**
 * The left rail: brand, primary routes, workspace routes, configure routes, help.
 *
 * Ported from `Berry Prototype.dc.html`. Nav items are links rather than click
 * handlers so middle-click, cmd-click, and "copy link address" behave the way
 * they do everywhere else — the prototype used div+onClick, which silently
 * removes all three.
 */
export function ShellRail({ orgId, active, onToggle, settingsMode }: ShellRailProps) {
   const t = useTranslations('shell');
   const nav = useTranslations('navigation.sidebar');
   const { visibility, order } = useSidebarPrefsStore();
   const [customizeOpen, setCustomizeOpen] = useState(false);
   const openIssueModal = useCreateIssueStore((state) => state.openModal);
   const draft = useCreateIssueStore((state) => state.draft);
   const isMobile = useIsMobile();
   const pathname = usePathname() ?? '';
   const lastPath = useRef(pathname);
   // A run that has not reached a terminal status is still going, which is what
   // the dot beside runtimes reports.
   const runsLive = useRunsStore((state) =>
      state.runs.some((run) => !isTerminalRunStatus(run.status))
   );

   // The preference store is persisted, so its first client value differs from
   // what the server rendered. Rendering the unfiltered list until mount keeps
   // hydration consistent, matching the legacy sidebar's behaviour.
   const [mounted, setMounted] = useState(false);
   useEffect(() => setMounted(true), []);

   // On a narrow screen the rail covers the page it navigated to, so going
   // somewhere closes it. Only on an actual change of route: closing on mount
   // would mean a deep link on a phone opens with the rail already dismissed,
   // which looks like the control does not work.
   useEffect(() => {
      if (pathname === lastPath.current) return;
      lastPath.current = pathname;
      if (isMobile) onToggle();
   }, [pathname, isMobile, onToggle]);

   /**
    * Apply the user's pin preferences to a section, returning what is shown in
    * the rail.
    */
   const partition = (routes: ShellRouteDef[], prefsSection?: SidebarSection) => {
      // Narrowing here rather than asserting later keeps prefsKey non-optional
      // for the rest of the function.
      const pinnable = routes.filter((route): route is PinnableRoute => Boolean(route.prefsKey));
      if (!mounted || pinnable.length === 0) return routes;

      const ordered = resolveOrder(
         prefsSection ? order[prefsSection] : undefined,
         pinnable.map((route) => route.prefsKey)
      )
         .map((key) => pinnable.find((route) => route.prefsKey === key))
         .filter((route): route is PinnableRoute => Boolean(route))
         .filter((route) => isSidebarItemVisible(visibility[route.prefsKey], 0));

      // Placeholders have no prefsKey and always show. Pinnable items keep the
      // user's order in the slots they occupy; hidden pins drop out.
      if (pinnable.length === routes.length) return ordered;

      const queue = [...ordered];
      const shown: ShellRouteDef[] = [];
      for (const route of routes) {
         if (!route.prefsKey) {
            shown.push(route);
            continue;
         }
         if (!isSidebarItemVisible(visibility[route.prefsKey], 0)) continue;
         const next = queue.shift();
         if (next) shown.push(next);
      }
      return shown;
   };

   return (
      <nav
         aria-label={t('rail.workspace')}
         className="flex w-[218px] flex-none flex-col bg-[var(--shell-rail)]"
      >
         {settingsMode ? (
            <ShellRailSettings orgId={orgId} />
         ) : (
            <>
               {/* The brand opens the workspace menu, as it does throughout the app.
             The prototype wired this row to collapse the rail, but a
             chevrons-up-down glyph reads as a switcher everywhere else in the
             product, and settings and log out have no other home. Collapse
             moves to its own control at the foot of the rail. */}
               <div className="flex items-center gap-1 px-3 pt-3">
                  <DropdownMenu>
                     <DropdownMenuTrigger asChild>
                        <button
                           type="button"
                           aria-label={t('rail.workspaceMenu')}
                           className="group/ws flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded px-3 py-2.5 text-left transition-colors hover:bg-[var(--shell-hover)] hover:text-[var(--shell-text)] data-[state=open]:bg-[var(--shell-hover)] data-[state=open]:text-[var(--shell-text)]"
                        >
                           <BerryMark size={24} />
                           <span
                              data-wordmark="md"
                              className="font-display leading-none tracking-[-0.025em] text-[var(--shell-text)]"
                           >
                              Berry<span className="text-[var(--shell-accent)]">.</span>
                           </span>
                           <svg
                              width="18"
                              height="18"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth={1.7}
                              className="ml-auto text-[var(--shell-text-dim)] transition-colors group-hover/ws:text-[var(--shell-text-muted)] group-data-[state=open]/ws:text-[var(--shell-text-muted)]"
                              aria-hidden="true"
                           >
                              <path d="M8 10l4-4 4 4M8 14l4 4 4-4" />
                           </svg>
                        </button>
                     </DropdownMenuTrigger>
                     <DropdownMenuContent
                        className="min-w-60 rounded-lg"
                        side="bottom"
                        align="start"
                     >
                        <WorkspaceMenuItems orgId={orgId} />
                     </DropdownMenuContent>
                  </DropdownMenu>
                  <button
                     type="button"
                     onClick={() => openIssueModal()}
                     aria-label={nav('newIssue')}
                     title={nav('newIssue')}
                     className={`relative size-[26px] ${shellIconButton}`}
                  >
                     <SquarePen className="size-3.5" />
                     {/* A dot, not a count: there is one draft, and what the
                         person needs to know is that it is still there. */}
                     {hasIssueDraft(draft) ? (
                        <span
                           aria-label={nav('draftWaiting')}
                           title={nav('draftWaiting')}
                           className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-[var(--shell-accent)]"
                        />
                     ) : null}
                  </button>
               </div>

               <ShellPersonal orgId={orgId} />

               {SHELL_SECTIONS.map((section) => {
                  const shown = partition(section.routes, section.prefsSection);
                  return (
                     <div key={section.heading ?? 'primary'}>
                        {section.heading ? (
                           <div className="px-6 pt-[18px] pb-[7px] uppercase tracking-[0.14em] text-[var(--shell-text-dim)]">
                              {section.headingKey ? t(`sections.${section.headingKey}`) : null}
                           </div>
                        ) : null}
                        <ul className="flex flex-col gap-1 px-3">
                           {shown.map((route) => {
                              const on = Boolean(route.href) && route.id === active;
                              const className = [
                                 'flex items-center gap-2.5 rounded px-3 py-1.5 transition-colors',
                                 on
                                    ? // Inset rather than a real border: a 2px edge on a rounded
                                      // pill would shift the label by two pixels on selection.
                                      'bg-[var(--shell-surface)] text-[var(--shell-text)]'
                                    : 'text-[var(--shell-text-muted)] hover:bg-[var(--shell-hover)] hover:text-[var(--shell-text)]',
                              ].join(' ');
                              const inner = (
                                 <>
                                    <ShellIcon path={route.icon} />
                                    {t(`nav.${route.labelKey}`)}
                                    {route.live === 'runs' && runsLive ? (
                                       <span
                                          aria-label={t('rail.runsInProgress')}
                                          title={t('rail.runsInProgress')}
                                          className="ml-auto size-[5px] rounded-full bg-[var(--brand-azure)] [animation:berrypulse_2s_ease-in-out_infinite] motion-reduce:animate-none"
                                       />
                                    ) : null}
                                 </>
                              );
                              return (
                                 <li key={route.id}>
                                    {route.href ? (
                                       <Link
                                          data-shell-nav
                                          href={`/${orgId}${route.href}`}
                                          aria-current={on ? 'page' : undefined}
                                          className={className}
                                       >
                                          {inner}
                                       </Link>
                                    ) : (
                                       <span data-shell-nav className={className}>
                                          {inner}
                                       </span>
                                    )}
                                 </li>
                              );
                           })}
                        </ul>
                     </div>
                  );
               })}
            </>
         )}

         <ShellPins orgId={orgId} />
         <div className="mt-auto flex items-center gap-1.5 p-3.5">
            <button
               type="button"
               onClick={() => setCustomizeOpen(true)}
               aria-label={t('rail.customizeSidebar')}
               title={t('rail.customizeSidebar')}
               className={`size-[26px] ${shellIconButton}`}
            >
               <RiSettings3Line className="size-3.5" />
            </button>
            <ShellHelp />
            <button
               type="button"
               onClick={onToggle}
               aria-label={t('rail.collapseSidebar')}
               title={t('rail.collapseSidebar')}
               className={`ml-auto size-[26px] ${shellIconButton}`}
            >
               <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.7}
               >
                  <path d="M14 6l-5 6 5 6" />
               </svg>
            </button>
         </div>
         <CustomizeSidebarDialog open={customizeOpen} onOpenChange={setCustomizeOpen} />
      </nav>
   );
}
