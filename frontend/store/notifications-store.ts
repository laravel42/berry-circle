import { InboxItem, NotificationType } from '@/data/inbox';
import { bulkUpdateInbox, updateInboxItem, type InboxAction } from '@/lib/inbox';
import { useSessionStore } from '@/store/session-store';
import { create } from 'zustand';

/** How far a list has got: the inbox and the archive load independently. */
export type InboxLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

interface NotificationsState {
   notifications: InboxItem[];
   /** The archive, loaded on demand: nothing fetches it until it is opened. */
   archived: InboxItem[];
   archivedStatus: InboxLoadStatus;
   status: InboxLoadStatus;
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
   /**
    * Ids the reader marked unread on purpose.
    *
    * Selecting a notification marks it read, which would otherwise undo the
    * deliberate act of marking one unread the moment the cursor landed back
    * on it. Held ids are released when the reader marks the item read again.
    */
   heldUnread: string[];

   hydrateNotifications: (notifications: InboxItem[]) => void;
   setStatus: (status: InboxLoadStatus) => void;
   hydrateArchived: (archived: InboxItem[]) => void;
   setArchivedStatus: (status: InboxLoadStatus) => void;
   clearArrivals: () => void;
   setServerUnreadCount: (count: number) => void;
   setSelectedNotification: (notification: InboxItem | undefined) => void;
   markAsRead: (id: string) => Promise<boolean>;
   /** Marks read only when the reader has not just held it unread. */
   markReadOnOpen: (id: string) => void;
   markAllAsRead: () => Promise<boolean>;
   markAsUnread: (id: string) => Promise<boolean>;
   archiveNotification: (id: string) => Promise<boolean>;
   unarchiveNotification: (id: string) => Promise<boolean>;
   archiveMany: (ids: string[]) => Promise<boolean>;

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

async function syncInboxAction(itemIds: string[], action: InboxAction): Promise<boolean> {
   const workspaceId = workspaceIdFromSession();
   if (!workspaceId || itemIds.length === 0) return false;
   if (itemIds.length === 1) return updateInboxItem(workspaceId, itemIds[0], action);
   return bulkUpdateInbox(workspaceId, itemIds, action);
}

/** Newest first, the order both lists are read in. */
function byNewest(items: InboxItem[]): InboxItem[] {
   return [...items].sort((left, right) => right.timestamp.localeCompare(left.timestamp));
}

/**
 * The badge counts what is unread and not archived, exactly as the server
 * does, so a local move and the next server figure agree.
 */
function unreadDelta(items: InboxItem[]): number {
   return items.filter((item) => !item.read).length;
}

export const useNotificationsStore = create<NotificationsState>((set, get) => ({
   notifications: [],
   archived: [],
   archivedStatus: 'idle',
   status: 'idle',
   selectedNotification: undefined,
   serverUnreadCount: null,
   arrivals: [],
   heldUnread: [],

   clearArrivals: () => set({ arrivals: [] }),

   setStatus: (status) => set({ status }),

   setArchivedStatus: (archivedStatus) => set({ archivedStatus }),

   hydrateArchived: (archived) => set({ archived: byNewest(archived), archivedStatus: 'ready' }),

   hydrateNotifications: (notifications) => {
      const { seen, primed } = trackSeen(notifications);
      const ordered = byNewest(notifications);
      set((state) => ({
         arrivals: primed ? notifications.filter((item) => !item.read && !seen.has(item.id)) : [],
         notifications: ordered,
         status: 'ready',
         // A refresh must not move the reader. The selection is re-resolved
         // from the fresh copy of the same notification, and dropped only
         // when that notification is no longer in the list.
         selectedNotification: state.selectedNotification
            ? ordered.find((item) => item.id === state.selectedNotification?.id)
            : undefined,
      }));
   },

   setServerUnreadCount: (count) => set({ serverUnreadCount: count }),

   setSelectedNotification: (notification: InboxItem | undefined) => {
      set({ selectedNotification: notification });
   },

   markAsRead: async (id: string) => {
      const target = get().notifications.find((item) => item.id === id);
      if (target?.read) return true;
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
         heldUnread: state.heldUnread.filter((held) => held !== id),
      }));
      return syncInboxAction([id], 'read');
   },

   markReadOnOpen: (id: string) => {
      if (get().heldUnread.includes(id)) return;
      void get().markAsRead(id);
   },

   markAllAsRead: async () => {
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
         heldUnread: [],
      }));
      if (unreadIds.length === 0) return true;
      return syncInboxAction(unreadIds, 'read');
   },

   markAsUnread: async (id: string) => {
      const target = get().notifications.find((item) => item.id === id);
      set((state) => ({
         notifications: state.notifications.map((notification) =>
            notification.id === id ? { ...notification, read: false } : notification
         ),
         selectedNotification:
            state.selectedNotification?.id === id
               ? { ...state.selectedNotification, read: false }
               : state.selectedNotification,
         serverUnreadCount:
            state.serverUnreadCount !== null && target?.read
               ? state.serverUnreadCount + 1
               : state.serverUnreadCount,
         heldUnread: state.heldUnread.includes(id) ? state.heldUnread : [...state.heldUnread, id],
      }));
      return syncInboxAction([id], 'unread');
   },

   archiveNotification: async (id: string) => {
      const moved = get().notifications.find((item) => item.id === id);
      if (!moved) return false;
      set((state) => ({
         notifications: state.notifications.filter((item) => item.id !== id),
         archived:
            state.archivedStatus === 'idle'
               ? state.archived
               : byNewest([{ ...moved, archived: true }, ...state.archived]),
         serverUnreadCount:
            state.serverUnreadCount !== null && !moved.read
               ? Math.max(0, state.serverUnreadCount - 1)
               : state.serverUnreadCount,
      }));
      return syncInboxAction([id], 'archive');
   },

   unarchiveNotification: async (id: string) => {
      const moved = get().archived.find((item) => item.id === id);
      if (!moved) return false;
      set((state) => ({
         archived: state.archived.filter((item) => item.id !== id),
         notifications: byNewest([{ ...moved, archived: false }, ...state.notifications]),
         serverUnreadCount:
            state.serverUnreadCount !== null && !moved.read
               ? state.serverUnreadCount + 1
               : state.serverUnreadCount,
      }));
      return syncInboxAction([id], 'unarchive');
   },

   archiveMany: async (ids: string[]) => {
      if (ids.length === 0) return true;
      const wanted = new Set(ids);
      const moved = get().notifications.filter((item) => wanted.has(item.id));
      if (moved.length === 0) return true;
      set((state) => ({
         notifications: state.notifications.filter((item) => !wanted.has(item.id)),
         archived:
            state.archivedStatus === 'idle'
               ? state.archived
               : byNewest([
                    ...moved.map((item) => ({ ...item, archived: true })),
                    ...state.archived,
                 ]),
         serverUnreadCount:
            state.serverUnreadCount !== null
               ? Math.max(0, state.serverUnreadCount - unreadDelta(moved))
               : state.serverUnreadCount,
      }));
      return syncInboxAction(
         moved.map((item) => item.id),
         'archive'
      );
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
