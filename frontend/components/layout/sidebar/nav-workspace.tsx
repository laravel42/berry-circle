'use client';

import { Box, ContactRound, LayoutList, LucideIcon, MoreHorizontal, Sparkles } from 'lucide-react';

import {
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuItem,
   DropdownMenuSeparator,
   DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
   SidebarGroup,
   SidebarGroupLabel,
   SidebarMenu,
   SidebarMenuButton,
   SidebarMenuItem,
} from '@/components/ui/sidebar';
import {
   isSidebarItemVisible,
   resolveOrder,
   SidebarItemKey,
   useSidebarPrefsStore,
} from '@/store/sidebar-prefs-store';
import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { isNavItemActive } from '@/lib/nav-active';
import { CustomizeSidebarDialog } from './customize-sidebar-dialog';

interface WorkspaceNavItem {
   key: SidebarItemKey;
   name: string;
   icon: LucideIcon;
   /** Path under /{orgId}. */
   url: string;
}

const WORKSPACE_NAV: WorkspaceNavItem[] = [
   { key: 'projects', name: 'projects', icon: Box, url: '/projects' },
   { key: 'teams', name: 'crews', icon: ContactRound, url: '/teams' },
   { key: 'agents', name: 'agents', icon: Sparkles, url: '/agents' },
];

export function NavWorkspace() {
   const { orgId } = useParams<{ orgId: string }>();
   const pathname = usePathname();
   const { visibility, order } = useSidebarPrefsStore();
   const [customizeOpen, setCustomizeOpen] = useState(false);
   const [mounted, setMounted] = useState(false);
   useEffect(() => setMounted(true), []);

   const orderedNav = mounted
      ? resolveOrder(
           order.workspace,
           WORKSPACE_NAV.map((item) => item.key)
        )
           .map((key) => WORKSPACE_NAV.find((item) => item.key === key))
           .filter((item): item is WorkspaceNavItem => Boolean(item))
      : WORKSPACE_NAV;

   const items = orderedNav.filter((item) => isSidebarItemVisible(visibility[item.key], 0));
   const hidden = orderedNav.filter((item) => !isSidebarItemVisible(visibility[item.key], 0));

   return (
      <SidebarGroup className="group-data-[collapsible=icon]:hidden">
         <SidebarGroupLabel>workspace</SidebarGroupLabel>
         <SidebarMenu>
            {items.map((item) => {
               const href = `/${orgId}${item.url}`;
               return (
                  <SidebarMenuItem key={item.key}>
                     <SidebarMenuButton asChild size="sm" isActive={isNavItemActive(pathname, href)}>
                        <Link href={href}>
                           <item.icon />
                           <span>{item.name}</span>
                        </Link>
                     </SidebarMenuButton>
                  </SidebarMenuItem>
               );
            })}
            <SidebarMenuItem>
               <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                     <SidebarMenuButton asChild size="sm">
                        <span>
                           <MoreHorizontal />
                           <span>more</span>
                        </span>
                     </SidebarMenuButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent className="w-48 rounded-lg" side="bottom" align="start">
                     {hidden.map((item) => (
                        <DropdownMenuItem key={item.key} asChild>
                           <Link href={`/${orgId}${item.url}`}>
                              <item.icon className="text-muted-foreground" />
                              <span>{item.name}</span>
                           </Link>
                        </DropdownMenuItem>
                     ))}
                     {hidden.length > 0 && <DropdownMenuSeparator />}
                     <DropdownMenuItem onClick={() => setCustomizeOpen(true)}>
                        <LayoutList className="text-muted-foreground" />
                        <span>customize sidebar</span>
                     </DropdownMenuItem>
                  </DropdownMenuContent>
               </DropdownMenu>
            </SidebarMenuItem>
         </SidebarMenu>
         <CustomizeSidebarDialog open={customizeOpen} onOpenChange={setCustomizeOpen} />
      </SidebarGroup>
   );
}
