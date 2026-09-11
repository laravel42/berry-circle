import { InboxItem, NotificationType } from '@/data/inbox';
import { bulkUpdateInbox, updateInboxItem } from '@/lib/inbox';
import { useSessionStore } from '@/store/session-store';
import { create } from 'zustand';

interface NotificationsState {
   notifications: InboxItem[];
   selectedNotification: InboxItem | undefined;
   serverUnreadCount: number | null;
   /**
    * Notifications that arrived since the last hydration, for the toaster.
    *
    * Kept as state rather than announced from here so the store stays free of
    * UI: something that renders subscribes, shows them and clears them. Empty
    * after the first hydration of a session — everything is new the first
    * time, and a stack of toasts for a backlog is not an announcement.
    */
   arrivals: InboxItem[];

   hydrateNotifications: (notifications: InboxItem[]) => void;
   clearArrivals: () => void;
   setServerUnreadCount: (count: number) => void;
   setSelectedNotification: (notification: InboxItem | undefined) => void;
   markAsRead: (id: string) => void;
   markAllAsRead: () => void;
   markAsUnread: (id: string) => void;
   /**
    * Take an item out of the inbox. Archiving is not reading: it is saying the
    * thing is dealt with, which is why it leaves the list rather than fading
    * in place.
    */
   archiveNotification: (id: string) => void;

   getUnreadNotifications: () => InboxItem[];
   getReadNotifications: () => InboxItem[];
   getNotificationsByType: (type: NotificationType) => InboxItem[];
   getNotificationsByUser: (userId: string) => InboxItem[];
   getNotificationById: (id: string) => InboxItem | undefined;
   getUnreadCount: () => number;
}

/**
 * Ids this session has already shown, and whether a first hydration happened.
 *
 * Module state rather than store state: it is bookkeeping for the toaster, not
 * something a component reads or renders.
 */
const seenIds = new Set<string>();
let hydratedOnce = false;

function trackSeen(notifications: InboxItem[]): { seen: Set<string>; primed: boolean } {
   const before = new Set(seenIds);
   const primed = hydratedOnce;
   for (const item of notifications) seenIds.add(item.id);
   hydratedOnce = true;
   return { seen: before, primed };
}

function workspaceIdFromSession(): string | undefined {
   return useSessionStore.getState().workspace?.id;
}

async function syncInboxAction(
   itemIds: string[],
   action: 'read' | 'unread' | 'archive' | 'unarchive'
): Promise<void> {
   const workspaceId = workspaceIdFromSession();
   if (!workspaceId) return;
   if (itemIds.length === 1) {
      await updateInboxItem(workspaceId, itemIds[0], action);
      return;
   }
   await bulkUpdateInbox(workspaceId, itemIds, action);
}

export const useNotificationsStore = create<NotificationsState>((set, get) => ({
   notifications: [],
   selectedNotification: undefined,
   serverUnreadCount: null,
   arrivals: [],

   clearArrivals: () => set({ arrivals: [] }),

   hydrateNotifications: (notifications) => {
      const { seen, primed } = trackSeen(notifications);
      set({
         arrivals: primed ? notifications.filter((item) => !item.read && !seen.has(item.id)) : [],
      });
      set({
         notifications,
         selectedNotification: notifications[0],
      });
   },

   setServerUnreadCount: (count) => set({ serverUnreadCount: count }),

   setSelectedNotification: (notification: InboxItem | undefined) => {
      set({ selectedNotification: notification });
   },

   markAsRead: (id: string) => {
      set((state) => ({
         notifications: state.notifications.map((notification) =>
            notification.id === id ? { ...notification, read: true } : notification
         ),
         selectedNotification:
            state.selectedNotification?.id === id
               ? { ...state.selectedNotification, read: true }
               : state.selectedNotification,
         serverUnreadCount:
            state.serverUnreadCount !== null
               ? Math.max(0, state.serverUnreadCount - 1)
               : state.serverUnreadCount,
      }));
      void syncInboxAction([id], 'read');
   },

   markAllAsRead: () => {
      const unreadIds = get()
         .notifications.filter((notification) => !notification.read)
         .map((notification) => notification.id);
      set((state) => ({
         notifications: state.notifications.map((notification) => ({
            ...notification,
            read: true,
         })),
         selectedNotification: state.selectedNotification
            ? { ...state.selectedNotification, read: true }
            : undefined,
         serverUnreadCount: 0,
      }));
      if (unreadIds.length > 0) {
         void syncInboxAction(unreadIds, 'read');
      }
   },

   markAsUnread: (id: string) => {
      set((state) => ({
         notifications: state.notifications.map((notification) =>
            notification.id === id ? { ...notification, read: false } : notification
         ),
         selectedNotification:
            state.selectedNotification?.id === id
               ? { ...state.selectedNotification, read: false }
               : state.selectedNotification,
         serverUnreadCount:
            state.serverUnreadCount !== null
               ? state.serverUnreadCount + 1
               : state.serverUnreadCount,
      }));
      void syncInboxAction([id], 'unread');
   },

   archiveNotification: (id: string) => {
      const item = get().notifications.find((notification) => notification.id === id);
      if (!item) return;
      set((state) => {
         const remaining = state.notifications.filter((notification) => notification.id !== id);
         return {
            notifications: remaining,
            // The selection moves to whatever took its place, so archiving
            // several in a row is one keystroke each rather than a keystroke
            // and a click.
            selectedNotification:
               state.selectedNotification?.id === id ? remaining[0] : state.selectedNotification,
            serverUnreadCount:
               state.serverUnreadCount !== null && !item.read
                  ? Math.max(0, state.serverUnreadCount - 1)
                  : state.serverUnreadCount,
         };
      });
      void syncInboxAction([id], 'archive');
   },

   getUnreadNotifications: () => {
      return get().notifications.filter((notification) => !notification.read);
   },

   getReadNotifications: () => {
      return get().notifications.filter((notification) => notification.read);
   },

   getNotificationsByType: (type: NotificationType) => {
      return get().notifications.filter((notification) => notification.type === type);
   },

   getNotificationsByUser: (userId: string) => {
      return get().notifications.filter((notification) => notification.user.id === userId);
   },

   getNotificationById: (id: string) => {
      return get().notifications.find((notification) => notification.id === id);
   },

   getUnreadCount: () => {
      const serverCount = get().serverUnreadCount;
      if (serverCount !== null) return serverCount;
      return get().notifications.filter((notification) => !notification.read).length;
   },
}));
