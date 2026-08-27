'use client';

import { shellIconButton } from '@/components/layout/shell/shell-icon';
import { useNotificationsDrawerStore } from '@/store/notifications-drawer-store';
import { useNotificationsStore } from '@/store/notifications-store';
import { Bell } from 'lucide-react';

/**
 * The bell at the right of the tab strip.
 *
 * Pinned outside the strip's scroll area: the tabs scroll when enough are
 * open, and a notification count that scrolls out of view is not a count.
 *
 * The badge is a number up to nine and a dot beyond it. Past a handful the
 * exact figure stops being information — what it is telling you is "more than
 * you are going to read one at a time".
 */
export function NotificationBell() {
   const toggle = useNotificationsDrawerStore((state) => state.toggle);
   const isOpen = useNotificationsDrawerStore((state) => state.isOpen);
   const notifications = useNotificationsStore((state) => state.notifications);
   const serverUnreadCount = useNotificationsStore((state) => state.serverUnreadCount);

   // The local list is what the drawer will show, so it is what the badge
   // counts. The server figure is the fallback before the first hydration,
   // when the list is empty but the count is already known.
   const local = notifications.filter((item) => !item.read).length;
   const unread = notifications.length > 0 ? local : (serverUnreadCount ?? 0);

   return (
      <button
         type="button"
         onClick={toggle}
         aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
         aria-expanded={isOpen}
         className={`relative my-[3.5px] mr-1.5 ml-1 size-[26px] ${shellIconButton}`}
      >
         <Bell size={15} strokeWidth={1.8} aria-hidden="true" />
         {unread > 0 ? (
            <span
               aria-hidden="true"
               // The badge is smaller than any element the base layer sizes, so its
               // size is set inline rather than with a text-* utility the
               // project reserves for globals.css.
               style={{ fontSize: '9px', lineHeight: '14px' }}
               className="absolute -top-0.5 -right-0.5 flex min-w-[14px] items-center justify-center rounded-full bg-primary px-[3px] font-medium text-primary-foreground"
            >
               {unread > 9 ? '' : unread}
            </span>
         ) : null}
      </button>
   );
}
