'use client';

import type { InboxItem } from '@/data/inbox';
import { getNotificationIcon } from '@/lib/notification-utils';
import { useNotificationsDrawerStore } from '@/store/notifications-drawer-store';
import { useNotificationsStore } from '@/store/notifications-store';
import { useTranslations } from 'next-intl';
import { useEffect } from 'react';
import { toast } from 'sonner';
import { destinationOf } from './notifications-drawer';
import { useParams, useRouter } from 'next/navigation';

/**
 * Announces notifications as they arrive.
 *
 * Renders nothing. The store records what came in since the last hydration
 * and this turns each into a toast, so the announcing lives beside the other
 * notification UI rather than inside a data store.
 *
 * Bounded at three. A burst — a plan compiling into fifteen tasks, an agent
 * finishing a run that touches several — would otherwise stack the corner of
 * the screen with a wall nobody reads, and the drawer already holds the rest.
 */
const MAX_TOASTS = 3;

export function NotificationToasts() {
   const router = useRouter();
   const params = useParams<{ orgId?: string }>();
   const orgId = params?.orgId ?? '';
   const t = useTranslations('inbox');
   const arrivals = useNotificationsStore((state) => state.arrivals);
   const clearArrivals = useNotificationsStore((state) => state.clearArrivals);
   const openDrawer = useNotificationsDrawerStore((state) => state.open);

   useEffect(() => {
      if (arrivals.length === 0) return;

      for (const item of arrivals.slice(0, MAX_TOASTS)) {
         toast(<NotificationToast item={item} />, {
            id: `notification:${item.id}`,
            duration: 6000,
            onDismiss: undefined,
            action: {
               label: t('toast.open'),
               onClick: () => {
                  const href = destinationOf(item, orgId);
                  if (href) router.push(href);
                  else openDrawer();
               },
            },
         });
      }

      if (arrivals.length > MAX_TOASTS) {
         const rest = arrivals.length - MAX_TOASTS;
         toast(t('toast.more', { count: rest }), {
            id: 'notification:overflow',
            duration: 6000,
            action: { label: t('toast.open'), onClick: openDrawer },
         });
      }

      clearArrivals();
   }, [arrivals, clearArrivals, openDrawer, orgId, router, t]);

   return null;
}

function NotificationToast({ item }: { item: InboxItem }) {
   return (
      <span className="flex min-w-0 items-start gap-2.5">
         <span className="mt-0.5 shrink-0">{getNotificationIcon(item.type, 'size-4')}</span>
         <span className="min-w-0">
            <span className="flex min-w-0 items-center gap-1.5">
               {item.identifier ? (
                  <span className="shrink-0 opacity-60">{item.identifier}</span>
               ) : null}
               <span className="truncate font-medium">{item.title}</span>
            </span>
            {item.content ? (
               <span className="mt-0.5 line-clamp-2 opacity-70">{item.content}</span>
            ) : null}
         </span>
      </span>
   );
}
