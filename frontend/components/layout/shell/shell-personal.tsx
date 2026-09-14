'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';

import { subscribeWorkspaceEvents } from '@/lib/events';
import { listThreads } from '@/lib/chat';
import { useNotificationsDrawerStore } from '@/store/notifications-drawer-store';
import { useNotificationsStore } from '@/store/notifications-store';
import { useSessionStore } from '@/store/session-store';
import { ShellIcon } from './shell-icon';
import { isMyTasks, MY_TASKS_HREF } from './shell-routes';

/** Past this the exact figure stops being information. */
const BADGE_CAP = 99;

const INBOX_ICON = '<path d="M4 13h4l1.5 3h5L16 13h4M4 13l2.5-7h11L20 13v5H4z" />';
const TASKS_ICON =
   '<path d="M5 7l2 2 4-4" /><path d="M5 16l2 2 4-4" /><path d="M13 7h6M13 17h6" />';
const CHAT_ICON = '<path d="M4 5h16v11H9l-5 4z" />';

/** `99+` past the cap: a number you cannot act on one at a time. */
function badgeText(count: number): string {
   return count > BADGE_CAP ? `${BADGE_CAP}+` : String(count);
}

function Badge({ count, label }: { count: number; label: string }) {
   if (count <= 0) return null;
   return (
      <span
         aria-label={label}
         // Smaller than anything the base type scale sizes, so the size is set
         // here rather than with a text utility the project keeps in globals.
         style={{ fontSize: '10px', lineHeight: '16px' }}
         className="ml-auto min-w-[18px] rounded-full bg-[var(--shell-line-strong)] px-1.5 text-center text-[var(--shell-text)]"
      >
         {badgeText(count)}
      </span>
   );
}

/**
 * The rail's "personal" section: the three places that are about you rather
 * than about the workspace.
 *
 * The inbox is a button, not a link: notifications are a drawer beside your
 * work, not a page you navigate away to. Its count and the chat count both
 * follow the workspace event stream, so a task assigned to you while you are
 * reading something else shows up without a refresh.
 */
export function ShellPersonal({ orgId }: { orgId: string }) {
   const t = useTranslations('navigation.sidebar');
   const pathname = usePathname() ?? '';
   const openNotifications = useNotificationsDrawerStore((state) => state.open);
   const notifications = useNotificationsStore((state) => state.notifications);
   const serverUnreadCount = useNotificationsStore((state) => state.serverUnreadCount);
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? '');
   const [chatUnread, setChatUnread] = useState(0);

   // The loaded list is what the drawer will show, so it is what the badge
   // counts; the server figure stands in until the first load arrives.
   const local = notifications.filter((item) => !item.read).length;
   const inboxUnread = notifications.length > 0 ? local : (serverUnreadCount ?? 0);

   const refreshChat = useCallback(() => {
      if (!workspaceId) return;
      void listThreads()
         .then((threads) => setChatUnread(threads.reduce((sum, thread) => sum + thread.unread, 0)))
         .catch(() => setChatUnread(0));
   }, [workspaceId]);

   useEffect(refreshChat, [refreshChat]);

   useEffect(() => {
      if (!workspaceId) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const unsubscribe = subscribeWorkspaceEvents((event) => {
         if (!/^(conversation|chat|message)\./.test(event.type)) return;
         if (timer) clearTimeout(timer);
         timer = setTimeout(refreshChat, 400);
      });
      return () => {
         if (timer) clearTimeout(timer);
         unsubscribe();
      };
   }, [workspaceId, refreshChat]);

   const rowClass = (on: boolean) =>
      [
         'flex w-full items-center gap-2.5 rounded px-3 py-1.5 text-left transition-colors',
         on
            ? 'bg-[var(--shell-surface)] text-[var(--shell-text)]'
            : 'text-[var(--shell-text-muted)] hover:bg-[var(--shell-hover)] hover:text-[var(--shell-text)]',
      ].join(' ');

   // Personal's entry is the assigned tab of the tasks page; the page with
   // every task is Work's Tasks, and only one of the two lights at a time.
   const search = useSearchParams()?.toString() ?? '';
   const onIssues = pathname.startsWith(`/${orgId}/my-issues`) && isMyTasks(pathname, search);
   const onChat = pathname.startsWith(`/${orgId}/chat`);

   return (
      <div>
         <div className="px-6 pt-[18px] pb-[7px] uppercase tracking-[0.14em] text-[var(--shell-text-dim)]">
            {t('personal')}
         </div>
         <ul className="flex flex-col gap-1 px-3">
            <li>
               <button
                  type="button"
                  data-shell-nav
                  onClick={openNotifications}
                  className={rowClass(false)}
               >
                  <ShellIcon path={INBOX_ICON} />
                  {t('inbox')}
                  <Badge
                     count={inboxUnread}
                     label={t('inboxUnread', { count: badgeText(inboxUnread) })}
                  />
               </button>
            </li>
            <li>
               <Link
                  data-shell-nav
                  href={`/${orgId}${MY_TASKS_HREF}`}
                  aria-current={onIssues ? 'page' : undefined}
                  className={rowClass(onIssues)}
               >
                  <ShellIcon path={TASKS_ICON} />
                  {t('myIssues')}
               </Link>
            </li>
            <li>
               <Link
                  data-shell-nav
                  href={`/${orgId}/chat`}
                  aria-current={onChat ? 'page' : undefined}
                  className={rowClass(onChat)}
               >
                  <ShellIcon path={CHAT_ICON} />
                  {t('chat')}
                  <Badge
                     count={chatUnread}
                     label={t('chatUnread', { count: badgeText(chatUnread) })}
                  />
               </Link>
            </li>
         </ul>
      </div>
   );
}
