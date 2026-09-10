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
   | 'upload'
   | 'approval'
   | 'goal'
   | 'workflow'
   | 'plan';

/** What a notification points at when it is not about a task. */
export interface InboxRef {
   id: string;
}

/**
 * An inbox notification. It is about one thing — a task, an approval, a
 * goal, a workflow run or a plan — and carries a reference to it so the
 * preview pane can show the real record rather than a summary of it.
 */
export interface InboxItem {
   id: string;
   /** The task key when the notification is about a task; empty otherwise. */
   identifier: string;
   title: string;
   content: string;
   type: NotificationType;
   /** The server's inbox category (`tasks`, `approvals`, `goals`, …). */
   category: string;
   user: User;
   timestamp: string;
   read: boolean;
   /** A snapshot of the task, with the status the notification recorded. */
   issue?: Issue;
   approval?: InboxRef;
   goal?: InboxRef;
   workflowRun?: InboxRef;
   plan?: InboxRef;
}
