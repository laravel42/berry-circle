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
 * An inbox notification. Extends the real `Issue` it belongs to
 * so the preview pane can show the actual issue.
 */
export interface InboxItem extends Issue {
   /** Notification-specific fields */
   content: string;
   type: NotificationType;
   user: User;
   timestamp: string;
   read: boolean;
}

/** Populated via the gateway API at runtime. */
export const inboxItems: InboxItem[] = [];
