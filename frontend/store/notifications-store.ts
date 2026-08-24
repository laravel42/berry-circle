import { InboxItem, inboxItems as mockNotifications, NotificationType } from '@/data/inbox';
import { bulkUpdateInbox, updateInboxItem } from '@/lib/inbox';
import { useSessionStore } from '@/store/session-store';
import { create } from 'zustand';

interface NotificationsState {
   notifications: InboxItem[];
   selectedNotification: InboxItem | undefined;
   serverUnreadCount: number | null;

   hydrateNotifications: (notifications: InboxItem[]) => void;
   setServerUnreadCount: (count: number) => void;
   setSelectedNotification: (notification: InboxItem | undefined) => void;
   markAsRead: (id: string) => void;
   markAllAsRead: () => void;
   markAsUnread: (id: string) => void;

   getUnreadNotifications: () => InboxItem[];
   getReadNotifications: () => InboxItem[];
   getNotificationsByType: (type: NotificationType) => InboxItem[];
   getNotificationsByUser: (userId: string) => InboxItem[];
   getNotificationById: (id: string) => InboxItem | undefined;
   getUnreadCount: () => number;
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
   notifications: mockNotifications,
   selectedNotification: undefined,
   serverUnreadCount: null,

   hydrateNotifications: (notifications) => {
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
            state.serverUnreadCount !== null ? state.serverUnreadCount + 1 : state.serverUnreadCount,
      }));
      void syncInboxAction([id], 'unread');
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
