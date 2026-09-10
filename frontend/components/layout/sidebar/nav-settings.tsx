'use client';

import {
   SidebarGroup,
   SidebarGroupLabel,
   SidebarMenu,
   SidebarMenuButton,
   SidebarMenuItem,
} from '@/components/ui/sidebar';
import {
   Bell,
   Blocks,
   Bot,
   Code,
   Columns3,
   KeyRound,
   Link2,
   ListChecks,
   LucideIcon,
   Plug,
   Settings,
   Sparkles,
   Tag,
   UserRound,
   Users,
   Server,
   Zap,
} from 'lucide-react';
import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import { isNavItemActive } from '@/lib/nav-active';

interface SettingsNavItem {
   name: string;
   /** Path under /{orgId}. */
   url: string;
   icon: LucideIcon;
}

interface SettingsNavGroup {
   label: string;
   items: SettingsNavItem[];
}

/** Default settings navigation. Unused routes stay live; they are not listed here. */
export const settingsNav: SettingsNavGroup[] = [
   {
      label: 'personal',
      items: [
         { name: 'preferences', url: '/settings/preferences', icon: Settings },
         { name: 'profile', url: '/settings/profile', icon: UserRound },
         { name: 'notifications', url: '/settings/notifications', icon: Bell },
         { name: 'security & access', url: '/settings/security', icon: KeyRound },
         { name: 'connected accounts', url: '/settings/connected-accounts', icon: Users },
      ],
   },
   {
      label: 'workspace',
      items: [
         { name: 'agents', url: '/settings/ai', icon: Sparkles },
         { name: 'agent personalization', url: '/settings/agent-personalization', icon: Bot },
         { name: 'runtimes', url: '/runtimes', icon: Server },
         { name: 'code & reviews', url: '/settings/code-and-reviews', icon: Code },
         { name: 'task labels', url: '/settings/issue-labels', icon: Tag },
         { name: 'statuses', url: '/settings/project-statuses', icon: Columns3 },
         { name: 'integrations', url: '/settings/integrations', icon: Blocks },
         { name: 'task fields', url: '/settings/issue-properties', icon: ListChecks },
         { name: 'quick actions', url: '/settings/quick-actions', icon: Zap },
         { name: 'join links', url: '/settings/join-links', icon: Link2 },
         { name: 'MCP servers', url: '/settings/mcp', icon: Plug },
      ],
   },
];

export function NavSettings() {
   const { orgId } = useParams<{ orgId: string }>();
   const pathname = usePathname();

   return (
      <>
         {settingsNav.map((group) => (
            <SidebarGroup key={group.label} className="group-data-[collapsible=icon]:hidden">
               <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
               <SidebarMenu>
                  {group.items.map((item) => {
                     const href = `/${orgId}${item.url}`;
                     const isActive = isNavItemActive(pathname, href);
                     return (
                        <SidebarMenuItem key={`${group.label}-${item.name}`}>
                           <SidebarMenuButton asChild size="sm" isActive={isActive}>
                              <Link href={href}>
                                 <item.icon />
                                 <span>{item.name}</span>
                              </Link>
                           </SidebarMenuButton>
                        </SidebarMenuItem>
                     );
                  })}
               </SidebarMenu>
            </SidebarGroup>
         ))}
      </>
   );
}
