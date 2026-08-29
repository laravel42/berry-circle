'use client';

import { Button } from '@/components/ui/button';
import {
   Sheet,
   SheetContent,
   SheetDescription,
   SheetHeader,
   SheetTitle,
} from '@/components/ui/sheet';
import type { InboxItem } from '@/data/inbox';
import { getNotificationIcon } from '@/lib/notification-utils';
import { cn } from '@/lib/utils';
import { useNotificationsDrawerStore } from '@/store/notifications-drawer-store';
import { useNotificationsStore } from '@/store/notifications-store';
import { formatDistanceToNow, parseISO } from 'date-fns';
import { useParams, useRouter } from 'next/navigation';
import { useMemo } from 'react';

/**
 * Notifications, as a drawer rather than a page.
 *
 * The inbox used to be a destination: a rail item, a route, and a two-pane
 * reader you navigated away from your work to visit. Nothing about a
 * notification wants that. It is an interruption you glance at and act on, so
 * it now arrives beside what you were already doing and leaves again.
 */
export function NotificationsDrawer() {
   const router = useRouter();
   const params = useParams<{ orgId?: string }>();
   const orgId = params?.orgId ?? '';
   const { isOpen, close } = useNotificationsDrawerStore();
   const notifications = useNotificationsStore((state) => state.notifications);
   const markAsRead = useNotificationsStore((state) => state.markAsRead);
   const markAllAsRead = useNotificationsStore((state) => state.markAllAsRead);

   // Unread first, then newest. A notification you have not seen is the reason
   // the drawer is open; one you have is history.
   const ordered = useMemo(() => {
      return [...notifications].sort((left, right) => {
         if (left.read !== right.read) return left.read ? 1 : -1;
         return right.timestamp.localeCompare(left.timestamp);
      });
   }, [notifications]);

   const unread = ordered.filter((item) => !item.read).length;

   const openNotification = (item: InboxItem) => {
      if (!item.read) markAsRead(item.id);
      const href = destinationOf(item, orgId);
      if (href) {
         close();
         router.push(href);
      }
   };

   return (
      <Sheet open={isOpen} onOpenChange={(next) => !next && close()}>
         <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-[28rem]">
            {/* pr-12 keeps the action clear of the sheet's own close control,
                which is absolutely positioned in this corner. */}
            <SheetHeader className="flex-row items-center justify-between space-y-0 border-b py-3 pr-12 pl-5">
               <div className="min-w-0">
                  <SheetTitle className="font-medium">Notifications</SheetTitle>
                  <SheetDescription className="sr-only">
                     What happened on your work while you were elsewhere.
                  </SheetDescription>
               </div>
               {unread > 0 ? (
                  <Button size="xs" variant="ghost" onClick={markAllAsRead}>
                     Mark all read
                  </Button>
               ) : null}
            </SheetHeader>

            {ordered.length === 0 ? (
               <div className="flex flex-1 items-center justify-center px-6 text-center text-muted-foreground">
                  Nothing has happened yet.
               </div>
            ) : (
               <div className="min-h-0 flex-1 overflow-y-auto">
                  {ordered.map((item) => (
                     <button
                        key={item.id}
                        type="button"
                        onClick={() => openNotification(item)}
                        className={cn(
                           'flex w-full items-start gap-3 border-b border-border/50 px-5 py-3 text-left',
                           'hover:bg-sidebar/50',
                           item.read && 'opacity-60'
                        )}
                     >
                        <span className="mt-0.5 shrink-0">
                           {getNotificationIcon(item.type, 'size-4')}
                        </span>
                        <span className="min-w-0 flex-1">
                           <span className="flex min-w-0 items-center gap-1.5">
                              {item.identifier ? (
                                 <span className="shrink-0 text-muted-foreground">
                                    {item.identifier}
                                 </span>
                              ) : null}
                              <span className="truncate font-medium">{item.title}</span>
                           </span>
                           {item.content ? (
                              <span className="mt-0.5 line-clamp-2 text-muted-foreground">
                                 {item.content}
                              </span>
                           ) : null}
                           <span className="mt-1 block text-muted-foreground">
                              {relativeTime(item.timestamp)}
                           </span>
                        </span>
                        {item.read ? null : (
                           <span
                              aria-label="Unread"
                              className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary"
                           />
                        )}
                     </button>
                  ))}
               </div>
            )}
         </SheetContent>
      </Sheet>
   );
}

/** Where a notification takes you, or nothing when it points at no record. */
export function destinationOf(item: InboxItem, orgId: string): string | null {
   if (!orgId) return null;
   if (item.identifier) return `/${orgId}/issue/${item.identifier}`;
   if (item.plan?.id) return `/${orgId}/plan/${item.plan.id}`;
   if (item.goal?.id) return `/${orgId}/goal/${item.goal.id}`;
   if (item.approval?.id) return `/${orgId}/approvals`;
   return null;
}

function relativeTime(timestamp: string): string {
   try {
      return formatDistanceToNow(parseISO(timestamp), { addSuffix: true });
   } catch {
      return timestamp;
   }
}
