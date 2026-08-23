'use client';

import Link from 'next/link';
import { PlusIcon } from 'lucide-react';
import { useParams, usePathname } from 'next/navigation';

import {
   SidebarGroup,
   SidebarGroupLabel,
   SidebarMenu,
   SidebarMenuButton,
   SidebarMenuItem,
} from '@/components/ui/sidebar';
import { useTeamsStore } from '@/store/teams-store';
import { isNavItemActive } from '@/lib/nav-active';

export function NavTeamsSettings() {
   const { orgId } = useParams<{ orgId: string }>();
   const pathname = usePathname();
   const teams = useTeamsStore((state) => state.teams);
   const joinedTeams = teams.filter((crew) => crew.joined);
   if (joinedTeams.length === 0) return null;

   return (
      <SidebarGroup className="group-data-[collapsible=icon]:hidden">
         <SidebarGroupLabel>your crews</SidebarGroupLabel>
         <SidebarMenu>
            {joinedTeams.map((team) => {
               const href = `/${orgId}/settings/teams/${team.id}`;
               return (
                  <SidebarMenuItem key={team.id}>
                     <SidebarMenuButton asChild isActive={isNavItemActive(pathname, href)}>
                        <Link href={href}>
                           <div className="inline-flex size-6 shrink-0 items-center justify-center rounded bg-muted/50">
                              <div className="text-sm">{team.icon}</div>
                           </div>
                           <span>{team.name}</span>
                        </Link>
                     </SidebarMenuButton>
                  </SidebarMenuItem>
               );
            })}
            <SidebarMenuItem>
               <SidebarMenuButton
                  asChild
                  size="sm"
                  isActive={isNavItemActive(pathname, `/${orgId}/settings/teams/new`)}
               >
                  <Link href={`/${orgId}/settings/teams/new`}>
                     <PlusIcon />
                     <span>join or create a team</span>
                  </Link>
               </SidebarMenuButton>
            </SidebarMenuItem>
         </SidebarMenu>
      </SidebarGroup>
   );
}
