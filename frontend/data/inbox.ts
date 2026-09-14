import { Issue } from './issues';
import { User } from './users';

/**
 * What a notification is about.
 *
 * One entry per thing that can happen to your work, because the row's icon and
 * its one-line label are the only things a reader scans before deciding whether
 * to open it. `assignment` and `unassigned` are separate for that reason, as
 * are a run finishing and a run failing.
 */
export type NotificationType =
   | 'comment'
   | 'mention'
   | 'assignment'
   | 'unassigned'
   | 'subscribed'
   | 'fieldChange'
   | 'reviewRequested'
   | 'reaction'
   | 'status'
   | 'reopened'
   | 'closed'
   | 'edited'
   | 'created'
   | 'upload'
   | 'approval'
   | 'goal'
   | 'workflow'
   | 'plan'
   | 'runCompleted'
   | 'runFailed'
   | 'agentBlocked'
   | 'agentCompleted'
   | 'autopilotPaused';

/** Every notification type, in the order the inbox groups them for a reader. */
export const NOTIFICATION_TYPES: NotificationType[] = [
   'assignment',
   'unassigned',
   'subscribed',
   'fieldChange',
   'comment',
   'mention',
   'reviewRequested',
   'reaction',
   'status',
   'reopened',
   'closed',
   'edited',
   'created',
   'upload',
   'approval',
   'goal',
   'workflow',
   'plan',
   'runCompleted',
   'runFailed',
   'agentBlocked',
   'agentCompleted',
   'autopilotPaused',
];

/** What a notification points at when it is not about a task. */
export interface InboxRef {
   id: string;
}

/** Who caused the notification, as the row records it. */
export interface InboxActor {
   id: string;
   type: 'user' | 'agent';
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
   /** The raw server event, kept so a screen can be specific about a subtype. */
   eventType: string;
   /** `info`, `warning` or `critical`, as the row recorded it. */
   severity: string;
   /** The recipient. Kept for surfaces that group an inbox by its owner. */
   user: User;
   /** Who caused it, when the row names someone. */
   actor: InboxActor | null;
   timestamp: string;
   read: boolean;
   archived: boolean;
   /** A snapshot of the task, with the status the notification recorded. */
   issue?: Issue;
   /** The task's id, even when the task itself is gone. */
   issueId?: string | null;
   /**
    * The notification is about a task that has since been deleted. The server
    * resolves the identifier through a not-deleted join, so a row with a task
    * id and no identifier is exactly this case.
    */
   issueDeleted: boolean;
   /** The comment this notification is about, so the detail can point at it. */
   commentId?: string | null;
   commentBody?: string | null;
   /** The prompt an agent was given, when the row recorded one. */
   prompt?: string | null;
   approval?: InboxRef;
   goal?: InboxRef;
   workflowRun?: InboxRef;
   plan?: InboxRef;
}
