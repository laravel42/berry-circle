'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { LayoutList } from 'lucide-react';
import {
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuItem,
   DropdownMenuSeparator,
   DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { CustomizeSidebarDialog } from '@/components/layout/sidebar/customize-sidebar-dialog';
import {
   isSidebarItemVisible,
   resolveOrder,
   useSidebarPrefsStore,
   type SidebarItemKey,
} from '@/store/sidebar-prefs-store';
import { MORE_ICON, SHELL_SECTIONS, type ShellRouteDef, type ShellRoute } from './shell-routes';
import { ShellIcon, BerryMark } from './shell-icon';
import { WorkspaceMenuItems } from './workspace-menu';
import { ShellRailSettings } from './shell-rail-settings';

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
 * The left rail: brand, primary routes, workspace routes, help.
 *
 * Ported from `Berry Prototype.dc.html`. Nav items are links rather than click
 * handlers so middle-click, cmd-click, and "copy link address" behave the way
 * they do everywhere else — the prototype used div+onClick, which silently
 * removes all three.
 */
export function ShellRail({ orgId, active, onToggle, settingsMode }: ShellRailProps) {
   const { visibility, order } = useSidebarPrefsStore();
   const [customizeOpen, setCustomizeOpen] = useState(false);

   // The preference store is persisted, so its first client value differs from
   // what the server rendered. Rendering the unfiltered list until mount keeps
   // hydration consistent, matching the legacy sidebar's behaviour.
   const [mounted, setMounted] = useState(false);
   useEffect(() => setMounted(true), []);

   /**
    * Apply the user's pin preferences to a section, returning what is shown in
    * the rail and what is tucked behind "more".
    */
   const partition = (routes: ShellRouteDef[]) => {
      // Narrowing here rather than asserting later keeps prefsKey non-optional
      // for the rest of the function.
      const pinnable = routes.filter((route): route is PinnableRoute => Boolean(route.prefsKey));
      if (!mounted || pinnable.length === 0) return { shown: routes, hidden: [] as ShellRouteDef[] };

      const ordered = resolveOrder(
         order.workspace,
         pinnable.map((route) => route.prefsKey),
      )
         .map((key) => pinnable.find((route) => route.prefsKey === key))
         .filter((route): route is PinnableRoute => Boolean(route));

      return {
         shown: ordered.filter((route) => isSidebarItemVisible(visibility[route.prefsKey], 0)),
         hidden: ordered.filter((route) => !isSidebarItemVisible(visibility[route.prefsKey], 0)),
      };
   };

   return (
      <nav
         aria-label="Workspace"
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
         <DropdownMenu>
            <DropdownMenuTrigger asChild>
               <button
                  type="button"
                  aria-label="Workspace menu"
                  className="flex w-full cursor-pointer items-center gap-2.5 px-3.5 pt-4 pb-3.5 text-left transition-colors hover:bg-[var(--shell-hover)] data-[state=open]:bg-[var(--shell-hover)]"
               >
                  <BerryMark />
                  <span className="font-display text-[15px] tracking-[-0.01em] text-[var(--shell-text)]">
                     Berry<span className="text-[var(--shell-accent)]">.</span>
                  </span>
                  <svg
                     width="13"
                     height="13"
                     viewBox="0 0 24 24"
                     fill="none"
                     stroke="currentColor"
                     strokeWidth={1.7}
                     className="ml-auto text-[var(--shell-text-dim)]"
                     aria-hidden="true"
                  >
                     <path d="M8 10l4-4 4 4M8 14l4 4 4-4" />
                  </svg>
               </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="min-w-60 rounded-lg" side="bottom" align="start" sideOffset={4}>
               <WorkspaceMenuItems orgId={orgId} />
            </DropdownMenuContent>
         </DropdownMenu>

         {SHELL_SECTIONS.map((section) => {
            const { shown, hidden } = partition(section.routes);
            const pinnable = section.routes.some((route) => route.prefsKey);
            return (
               <div key={section.heading ?? 'primary'}>
                  {section.heading ? (
                     <div className="px-[18px] pt-[18px] pb-[7px] text-xs uppercase tracking-[0.14em] text-[var(--shell-text-dim)]">
                        {section.heading}
                     </div>
                  ) : null}
                  <ul className="flex flex-col gap-px px-2">
                     {shown.map((route) => {
                        const on = route.id === active;
                        return (
                           <li key={route.id}>
                              <Link
                                 href={`/${orgId}${route.href}`}
                                 aria-current={on ? 'page' : undefined}
                                 className={[
                                    'flex items-center gap-2.5 rounded px-2.5 py-1.5 transition-colors',
                                    on
                                       ? 'bg-[var(--shell-surface)] text-[var(--shell-text)]'
                                       : 'text-[var(--shell-text-muted)] hover:bg-[var(--shell-hover)] hover:text-[var(--shell-text)]',
                                 ].join(' ')}
                              >
                                 <ShellIcon path={route.icon} />
                                 {route.label}
                              </Link>
                           </li>
                        );
                     })}

                     {/* "more" is a control, not a destination: it lists what is
                         unpinned and opens the dialog that decides what stays in
                         the rail. It previously linked to settings, which lost
                         both behaviours. */}
                     {pinnable ? (
                        <li>
                           <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                 <button
                                    type="button"
                                    className="flex w-full cursor-pointer items-center gap-2.5 rounded px-2.5 py-1.5 text-left text-[var(--shell-text-muted)] transition-colors hover:bg-[var(--shell-hover)] hover:text-[var(--shell-text)] data-[state=open]:bg-[var(--shell-hover)] data-[state=open]:text-[var(--shell-text)]"
                                 >
                                    <ShellIcon path={MORE_ICON} />
                                    more
                                 </button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent className="w-48 rounded-lg" side="bottom" align="start">
                                 {hidden.map((route) => (
                                    <DropdownMenuItem key={route.id} asChild>
                                       <Link href={`/${orgId}${route.href}`}>{route.label}</Link>
                                    </DropdownMenuItem>
                                 ))}
                                 {hidden.length > 0 ? <DropdownMenuSeparator /> : null}
                                 <DropdownMenuItem onClick={() => setCustomizeOpen(true)}>
                                    <LayoutList className="text-muted-foreground" />
                                    <span>customize sidebar</span>
                                 </DropdownMenuItem>
                              </DropdownMenuContent>
                           </DropdownMenu>
                        </li>
                     ) : null}
                  </ul>
               </div>
            );
         })}

            </>
         )}

         <div className="mt-auto flex items-center gap-1.5 p-3.5">
            <Link
               href={`/${orgId}/settings/preferences`}
               aria-label="Help and settings"
               className="flex size-[26px] items-center justify-center rounded-[5px] border border-[var(--shell-line)] text-[var(--shell-text-dim)] transition-colors hover:border-[var(--shell-line-strong)] hover:text-[var(--shell-text)]"
            >
               ?
            </Link>
            <button
               type="button"
               onClick={onToggle}
               aria-label="Collapse sidebar"
               title="Collapse sidebar"
               className="flex size-[26px] items-center justify-center rounded-[5px] border border-[var(--shell-line)] text-[var(--shell-text-dim)] transition-colors hover:border-[var(--shell-line-strong)] hover:text-[var(--shell-text)]"
            >
               <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
                  <path d="M14 6l-5 6 5 6" />
               </svg>
            </button>
         </div>
         <CustomizeSidebarDialog open={customizeOpen} onOpenChange={setCustomizeOpen} />
      </nav>
   );
}
