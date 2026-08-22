import { Issue } from './issues';
import { User } from './users';

export type NotificationType =
   | 'comment'
   | 'mention'
   | 'assignment'
   | 'status'
   | 'reopened'
   | 'closed'
   | 'edited'
   | 'created'
   | 'upload';

/**
 * An inbox notification. It extends the real `Issue` it belongs to
 * (found by identifier) so the preview pane can show the actual issue.
 */
export interface InboxItem extends Issue {
   /** Notification-specific fields */
   content: string;
   type: NotificationType;
   user: User;
   timestamp: string;
   read: boolean;
}

/** Inbox items. Empty until the gateway provides notifications. */
export const inboxItems: InboxItem[] = [];
