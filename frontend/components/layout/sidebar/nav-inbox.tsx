'use client';

import {
   SidebarGroup,
   SidebarMenu,
   SidebarMenuBadge,
   SidebarMenuButton,
   SidebarMenuItem,
} from '@/components/ui/sidebar';
import { loadReviews } from '@/lib/reviews';
import { useSessionStore } from '@/store/session-store';
import { inboxItems } from '@/data/side-bar-nav';
import { useNotificationsStore } from '@/store/notifications-store';
import {
   isSidebarItemVisible,
   resolveOrder,
   SidebarItemKey,
   useSidebarPrefsStore,
} from '@/store/sidebar-prefs-store';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { isNavItemActive } from '@/lib/nav-active';

const ITEM_KEYS: Record<string, SidebarItemKey> = {
   issues: 'my-issues',
   runs: 'agent',
   reviews: 'reviews',
   inbox: 'inbox',
};

export function NavInbox() {
   const pathname = usePathname();
   const { visibility, badgeStyle, order } = useSidebarPrefsStore();
   const { getUnreadCount } = useNotificationsStore();
   const [mounted, setMounted] = useState(false);
   useEffect(() => setMounted(true), []);
   const workspace = useSessionStore((state) => state.workspace);
   // How many tasks wait at the review gate, from the API. Read once per
   // workspace: the badge is a hint, and the Reviews page is the truth.
   const [waiting, setWaiting] = useState(0);
   useEffect(() => {
      if (!workspace) return;
      let cancelled = false;
      loadReviews(workspace.id, 'open')
         .then((items) => {
            if (!cancelled) setWaiting(items.length);
         })
         .catch(() => undefined);
      return () => {
         cancelled = true;
      };
   }, [workspace]);

   const unread = mounted ? getUnreadCount() : 0;

   const orderedItems = mounted
      ? resolveOrder(order.personal, inboxItems.map((item) => ITEM_KEYS[item.name]).filter(Boolean))
           .map((key) => inboxItems.find((item) => ITEM_KEYS[item.name] === key))
           .filter((item): item is (typeof inboxItems)[number] => Boolean(item))
      : inboxItems;

   const items = orderedItems.filter((item) => {
      const key = ITEM_KEYS[item.name];
      if (!key) return true;
      const badge = key === 'inbox' ? unread : key === 'reviews' ? waiting : 0;
      return isSidebarItemVisible(visibility[key], badge);
   });

   return (
      <SidebarGroup className="group-data-[collapsible=icon]:hidden">
         <SidebarMenu>
            {items.map((item) => (
               <SidebarMenuItem key={item.name}>
                  <SidebarMenuButton
                     asChild
                     size="sm"
                     isActive={isNavItemActive(pathname, item.url)}
                  >
                     <Link href={item.url}>
                        <item.icon />
                        <span>{item.name}</span>
                     </Link>
                  </SidebarMenuButton>
                  {mounted && item.name === 'inbox' && unread > 0 && (
                     <SidebarMenuBadge className="text-muted-foreground">
                        {badgeStyle === 'count' ? (
                           unread > 99 ? (
                              '99+'
                           ) : (
                              unread
                           )
                        ) : (
                           <span className="size-1.5 rounded-full bg-muted-foreground inline-block" />
                        )}
                     </SidebarMenuBadge>
                  )}
               </SidebarMenuItem>
            ))}
         </SidebarMenu>
      </SidebarGroup>
   );
}
