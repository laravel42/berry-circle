'use client';

import Link from 'next/link';
import {
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SHELL_SECTIONS, type ShellRoute } from './shell-routes';
import { ShellIcon, BerryMark } from './shell-icon';
import { WorkspaceMenuItems } from './workspace-menu';

interface ShellRailProps {
   orgId: string;
   active: ShellRoute | null;
   onToggle: () => void;
}

/**
 * The left rail: brand, primary routes, workspace routes, help.
 *
 * Ported from `Berry Prototype.dc.html`. Nav items are links rather than click
 * handlers so middle-click, cmd-click, and "copy link address" behave the way
 * they do everywhere else — the prototype used div+onClick, which silently
 * removes all three.
 */
export function ShellRail({ orgId, active, onToggle }: ShellRailProps) {
   return (
      <nav
         aria-label="Workspace"
         className="flex w-[218px] flex-none flex-col bg-[var(--shell-rail)]"
      >
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

         {SHELL_SECTIONS.map((section) => (
            <div key={section.heading ?? 'primary'}>
               {section.heading ? (
                  <div className="px-[18px] pt-[18px] pb-[7px] text-xs uppercase tracking-[0.14em] text-[var(--shell-text-dim)]">
                     {section.heading}
                  </div>
               ) : null}
               <ul className="flex flex-col gap-px px-2">
                  {section.routes.map((route) => {
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
               </ul>
            </div>
         ))}

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
      </nav>
   );
}
