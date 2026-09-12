import type { InboxItem } from '@/data/inbox';
import { formatDistanceToNow, parseISO } from 'date-fns';

/** "3 minutes ago", or the raw stamp when it cannot be read. */
export function relativeTime(timestamp: string): string {
   try {
      return formatDistanceToNow(parseISO(timestamp), { addSuffix: true });
   } catch {
      return timestamp;
   }
}

/**
 * Where a notification takes you when it is opened in its own tab.
 *
 * A task that has been deleted has nowhere to go; the inbox says so in the
 * detail pane rather than sending a reader to a page that will not load.
 */
export function inboxHref(item: InboxItem, orgId: string): string | null {
   if (!orgId) return null;
   if (item.identifier) return `/${orgId}/issue/${item.identifier}`;
   if (item.plan?.id) return `/${orgId}/plan/${item.plan.id}`;
   if (item.goal?.id) return `/${orgId}/goal/${item.goal.id}`;
   if (item.approval?.id) return `/${orgId}/approvals`;
   return null;
}

/**
 * True when the notification reports the outcome of agent work.
 *
 * These are the ones worth offering to run again: the reader is looking at
 * what an agent did, and the next thing they want is usually another attempt
 * with the same instructions.
 */
export function isAgentOutcome(item: InboxItem): boolean {
   return (
      item.type === 'runCompleted' ||
      item.type === 'runFailed' ||
      item.type === 'agentBlocked' ||
      item.type === 'agentCompleted' ||
      (item.actor?.type === 'agent' && item.type === 'created')
   );
}
