'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ChevronLeft } from 'lucide-react';

import { settingsNav } from '@/components/layout/sidebar/nav-settings';
import { isNavItemActive } from '@/lib/nav-active';

/**
 * Settings mode for the rail.
 *
 * `AppSidebar` swapped its whole contents on settings routes — back-to-app plus
 * the settings groups — and the shell rail had no equivalent, so settings lost
 * its navigation entirely.
 *
 * The route data comes from `settingsNav` in `nav-settings.tsx`,
 * so the two cannot list different settings pages. Only the presentation is
 * reimplemented: the legacy components render sidebar primitives styled for the
 * light Circle sidebar, which would sit wrong in the dark rail and, being
 * outside SidebarProvider here, would throw.
 */
export function ShellRailSettings({ orgId }: { orgId: string }) {
   const pathname = usePathname() ?? '';
   const t = useTranslations('workspaceAdmin');

   const link = (active: boolean) =>
      [
         'flex items-center gap-2.5 rounded px-3 py-1.5 transition-colors',
         active
            ? 'bg-[var(--shell-surface)] text-[var(--shell-text)]'
            : 'text-[var(--shell-text-muted)] hover:bg-[var(--shell-hover)] hover:text-[var(--shell-text)]',
      ].join(' ');

   return (
      <>
         <div className="px-3.5 pt-4 pb-3.5">
            <Link
               href={`/${orgId}/tasks`}
               className="flex w-fit items-center gap-1.5 rounded-[5px] bg-[var(--shell-line)] px-2 py-1 text-[var(--shell-text-muted)] transition-colors hover:bg-[var(--shell-line-strong)] hover:text-[var(--shell-text)]"
            >
               <ChevronLeft className="size-4" />
               Back to app
            </Link>
         </div>

         {settingsNav.map((group) => (
            <div key={group.labelKey}>
               <div className="px-6 pt-[18px] pb-[7px] uppercase tracking-[0.14em] text-[var(--shell-text-dim)]">
                  {t(`groups.${group.labelKey}`)}
               </div>
               <ul className="flex flex-col gap-1 px-3">
                  {group.items.map((item) => {
                     const href = `/${orgId}${item.url}`;
                     const active = isNavItemActive(pathname, href);
                     return (
                        <li key={`${group.labelKey}-${item.labelKey}`}>
                           <Link
                              data-shell-nav
                              href={href}
                              aria-current={active ? 'page' : undefined}
                              className={link(active)}
                           >
                              <item.icon className="size-[15px] flex-none" />
                              {t(`nav.${item.labelKey}`)}
                           </Link>
                        </li>
                     );
                  })}
               </ul>
            </div>
         ))}
      </>
   );
}
