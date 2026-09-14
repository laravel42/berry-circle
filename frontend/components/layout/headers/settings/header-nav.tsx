'use client';

import { ChevronDown } from 'lucide-react';
import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { settingsNav } from '@/components/layout/sidebar/nav-settings';
import {
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuItem,
   DropdownMenuLabel,
   DropdownMenuSeparator,
   DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { isNavItemActive } from '@/lib/nav-active';

/**
 * The settings header, and the only settings navigation on a narrow screen.
 *
 * The rail carries the grouped list, but it is a fixed 218px column: below the
 * shell's breakpoint it is either crushed or in the way, and settings had no
 * other way to move between pages. This dropdown is that way. It shows only
 * where the rail does not (`lg:hidden`), so the two are never both on screen
 * competing to be the navigation.
 *
 * It reads the same `settingsNav`, keeping the groups and their order, so a
 * page added to the rail appears here without a second edit.
 */
export default function HeaderNav() {
   const t = useTranslations('settings.header');
   const admin = useTranslations('workspaceAdmin');
   const pathname = usePathname() ?? '';
   const { orgId } = useParams<{ orgId: string }>();

   const current = settingsNav
      .flatMap((group) => group.items)
      .find((item) => isNavItemActive(pathname, `/${orgId}${item.url}`));

   return (
      <div className="w-full flex justify-between items-center border-b py-1.5 px-6 h-10">
         <div className="flex items-center gap-2">
            <div className="flex items-center gap-1">
               <span className="font-medium">{t('title')}</span>
            </div>
         </div>

         <DropdownMenu>
            <DropdownMenuTrigger
               aria-label={admin('jump.label')}
               className="lg:hidden inline-flex h-7 max-w-56 items-center gap-1.5 truncate rounded-md border bg-container px-2.5 outline-none transition-colors hover:bg-accent"
            >
               {current ? admin(`nav.${current.labelKey}`) : admin('jump.current')}
               <ChevronDown className="size-3.5 text-muted-foreground" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-[70svh] min-w-52 overflow-y-auto">
               {settingsNav.map((group, index) => (
                  <div key={group.labelKey}>
                     {index > 0 ? <DropdownMenuSeparator /> : null}
                     <DropdownMenuLabel className="uppercase tracking-[0.14em] text-muted-foreground">
                        {admin(`groups.${group.labelKey}`)}
                     </DropdownMenuLabel>
                     {group.items.map((item) => {
                        const href = `/${orgId}${item.url}`;
                        return (
                           <DropdownMenuItem key={item.labelKey} asChild>
                              <Link
                                 href={href}
                                 aria-current={isNavItemActive(pathname, href) ? 'page' : undefined}
                                 className="flex items-center gap-2"
                              >
                                 <item.icon className="size-4 text-muted-foreground" />
                                 {admin(`nav.${item.labelKey}`)}
                              </Link>
                           </DropdownMenuItem>
                        );
                     })}
                  </div>
               ))}
            </DropdownMenuContent>
         </DropdownMenu>
      </div>
   );
}
