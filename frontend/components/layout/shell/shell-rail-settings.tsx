'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronLeft, PlusIcon } from 'lucide-react';

import { settingsNav } from '@/components/layout/sidebar/nav-settings';
import { isNavItemActive } from '@/lib/nav-active';
import { useTeamsStore } from '@/store/teams-store';

/**
 * Settings mode for the rail.
 *
 * `AppSidebar` swapped its whole contents on settings routes — back-to-app plus
 * the settings groups and your crews — and the shell rail had no equivalent, so
 * settings lost its navigation entirely.
 *
 * The route data comes from `settingsNav`, which NavSettings already exports,
 * so the two cannot list different settings pages. Only the presentation is
 * reimplemented: the legacy components render sidebar primitives styled for the
 * light Circle sidebar, which would sit wrong in the dark rail and, being
 * outside SidebarProvider here, would throw.
 */
export function ShellRailSettings({ orgId }: { orgId: string }) {
   const pathname = usePathname() ?? '';
   const joinedCrews = useTeamsStore((state) => state.teams).filter((crew) => crew.joined);

   const link = (href: string, active: boolean) =>
      [
         'flex items-center gap-2.5 rounded px-2.5 py-1.5 transition-colors',
         active
            ? 'bg-[var(--shell-surface)] text-[var(--shell-text)]'
            : 'text-[var(--shell-text-muted)] hover:bg-[var(--shell-hover)] hover:text-[var(--shell-text)]',
      ].join(' ');

   return (
      <>
         <div className="px-3.5 pt-4 pb-3.5">
            <Link
               href={`/${orgId}/runs`}
               className="flex w-fit items-center gap-1.5 rounded-[5px] bg-[var(--shell-line)] px-2 py-1 text-[var(--shell-text-muted)] transition-colors hover:bg-[var(--shell-line-strong)] hover:text-[var(--shell-text)]"
            >
               <ChevronLeft className="size-4" />
               Back to app
            </Link>
         </div>

         {settingsNav.map((group) => (
            <div key={group.label}>
               <div className="px-[18px] pt-[18px] pb-[7px] text-xs uppercase tracking-[0.14em] text-[var(--shell-text-dim)]">
                  {group.label}
               </div>
               <ul className="flex flex-col gap-px px-2">
                  {group.items.map((item) => {
                     const href = `/${orgId}${item.url}`;
                     const active = isNavItemActive(pathname, href);
                     return (
                        <li key={`${group.label}-${item.name}`}>
                           <Link
                              href={href}
                              aria-current={active ? 'page' : undefined}
                              className={link(href, active)}
                           >
                              <item.icon className="size-[15px] flex-none" />
                              {item.name}
                           </Link>
                        </li>
                     );
                  })}
               </ul>
            </div>
         ))}

         {joinedCrews.length > 0 ? (
            <div>
               <div className="px-[18px] pt-[18px] pb-[7px] text-xs uppercase tracking-[0.14em] text-[var(--shell-text-dim)]">
                  your crews
               </div>
               <ul className="flex flex-col gap-px px-2">
                  {joinedCrews.map((crew) => {
                     const href = `/${orgId}/settings/teams/${crew.id}`;
                     const active = isNavItemActive(pathname, href);
                     return (
                        <li key={crew.id}>
                           <Link
                              href={href}
                              aria-current={active ? 'page' : undefined}
                              className={link(href, active)}
                           >
                              <span className="inline-flex size-5 flex-none items-center justify-center rounded bg-[var(--shell-line)]">
                                 {crew.icon}
                              </span>
                              {crew.name}
                           </Link>
                        </li>
                     );
                  })}
                  <li>
                     <Link
                        href={`/${orgId}/settings/teams/new`}
                        className={link(
                           '',
                           isNavItemActive(pathname, `/${orgId}/settings/teams/new`)
                        )}
                     >
                        <PlusIcon className="size-[15px] flex-none" />
                        join or create a team
                     </Link>
                  </li>
               </ul>
            </div>
         ) : null}
      </>
   );
}
