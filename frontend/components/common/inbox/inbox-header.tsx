'use client';

import { useNotificationsStore } from '@/store/notifications-store';
import { useTranslations } from 'next-intl';

/**
 * The page's one header row.
 *
 * The unread count is stated here rather than only on the bell, because on
 * this page the bell is the thing you just came from.
 */
export function InboxHeader() {
   const t = useTranslations('inbox');
   const unread = useNotificationsStore((state) => state.getUnreadCount());

   return (
      <div className="flex h-auto w-full flex-col gap-2 border-b px-6 py-3">
         <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
               <span className="font-medium">{t('title')}</span>
               <p className="mt-1 max-w-2xl text-muted-foreground">{t('description')}</p>
            </div>
            {unread > 0 ? (
               <span className="shrink-0 rounded-full bg-primary px-2 py-0.5 font-medium text-primary-foreground">
                  {unread}
               </span>
            ) : null}
         </div>
      </div>
   );
}
