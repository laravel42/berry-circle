import type { InboxActor, InboxItem, NotificationType } from '@/data/inbox';
import type { Issue } from '@/data/issues';
import type { User } from '@/data/users';
import { z } from 'zod';
import { apiFetch } from './api';
import { connectionSchema } from './api-schemas';
import { catalogPriority, catalogStatus, uiStatusFromApi } from './catalog';

const inboxSchema = z.object({
   id: z.string(),
   workspaceId: z.string(),
   recipientId: z.string(),
   eventType: z.string(),
   category: z.string(),
   severity: z.string(),
   issueId: z.string().nullable(),
   issueStatus: z.string().nullable(),
   issueIdentifier: z.string().nullable().optional(),
   actorType: z.string().nullable(),
   actorId: z.string().nullable(),
   title: z.string(),
   body: z.string().nullable(),
   read: z.boolean(),
   archived: z.boolean(),
   createdAt: z.string(),
   approvalId: z.string().nullish(),
   goalId: z.string().nullish(),
   planId: z.string().nullish(),
   /** Whatever the projection recorded about the event; shape varies by event. */
   details: z.record(z.unknown()).nullish(),
});

const inboxConnectionSchema = connectionSchema(inboxSchema);

type ApiInboxItem = z.infer<typeof inboxSchema>;

/** Which list to read: the working inbox or the archive. */
export type InboxState = 'active' | 'archived';

export type InboxAction = 'read' | 'unread' | 'archive' | 'unarchive';

export interface InboxQuery {
   state?: InboxState;
   unreadOnly?: boolean;
   first?: number;
}

/**
 * What a notification is about.
 *
 * The server's event type is the authority; the category is consulted only
 * where the event name is not specific enough. Matching is on whole segments
 * rather than a substring sweep, so `issue.unassigned` cannot be read as an
 * assignment because the word "assign" happens to appear inside it.
 */
function notificationType(item: ApiInboxItem): NotificationType {
   const event = item.eventType.toLowerCase();
   const category = item.category.toLowerCase();
   const details = item.details ?? {};

   if (event.startsWith('autopilot.')) {
      if (event.includes('pause')) return 'autopilotPaused';
      return 'workflow';
   }
   if (event.startsWith('run.') || event.startsWith('agent.')) {
      if (event.includes('block') || event.includes('await') || event.includes('input')) {
         return 'agentBlocked';
      }
      if (event.includes('fail') || event.includes('error') || event.includes('cancel')) {
         return 'runFailed';
      }
      if (event.startsWith('agent.')) return 'agentCompleted';
      return 'runCompleted';
   }
   if (item.approvalId || category === 'approvals' || event.startsWith('approval.')) {
      return 'approval';
   }
   if (item.planId || event.startsWith('plan.')) return 'plan';
   if (item.goalId && !item.issueId) return 'goal';
   if (event.startsWith('goal.')) return 'goal';
   if (event.includes('review')) return 'reviewRequested';
   if (event.includes('reaction') || category === 'reactions') return 'reaction';
   if (event.includes('mention') || category === 'mentions') return 'mention';
   if (event.includes('comment') || category === 'comments') return 'comment';
   if (event.includes('unassign')) return 'unassigned';
   if (event.includes('assign') || category === 'assignments') return 'assignment';
   if (event.includes('subscrib')) return 'subscribed';
   if (event.includes('reopen')) return 'reopened';
   if (event.includes('close') || event.includes('done')) return 'closed';
   if (event.includes('status') || category === 'statuschanges') return 'status';
   if (event.includes('upload') || event.includes('attach')) return 'upload';
   if (event.endsWith('.created')) return 'created';
   // An update that named the field it changed is a field change; one that
   // did not is a plain edit, which says less but claims less too.
   if (event.endsWith('.updated') || category === 'updates') {
      return typeof details.field === 'string' ? 'fieldChange' : 'edited';
   }
   return 'created';
}

function actorOf(item: ApiInboxItem): InboxActor | null {
   if (!item.actorId) return null;
   if (item.actorType !== 'user' && item.actorType !== 'agent') return null;
   return { id: item.actorId, type: item.actorType };
}

/** First string among the given keys, trimmed; undefined when none carries one. */
function detailString(details: Record<string, unknown>, keys: string[]): string | undefined {
   for (const key of keys) {
      const value = details[key];
      if (typeof value === 'string' && value.trim() !== '') return value;
   }
   return undefined;
}

/**
 * The task a notification recorded, as much of it as the inbox row carries.
 * The preview pane swaps in the live record from the issues store when it
 * has one; this is what shows until then.
 */
function issueSnapshot(item: ApiInboxItem): Issue | undefined {
   if (!item.issueId) return undefined;
   const fallbackStatus = catalogStatus('backlog');
   const fallbackPriority = catalogPriority('no-priority');
   if (!fallbackStatus || !fallbackPriority) return undefined;
   const status = item.issueStatus
      ? (uiStatusFromApi(item.issueStatus) ?? fallbackStatus)
      : fallbackStatus;
   return {
      id: item.issueId,
      // The server derives this from the workspace prefix and the issue's
      // number; an empty label is better than a wrong one.
      identifier: item.issueIdentifier ?? '',
      title: item.title,
      description: item.body ?? '',
      status,
      assignee: null,
      priority: fallbackPriority,
      labels: [],
      createdAt: item.createdAt,
      cycleId: '',
      rank: item.createdAt,
      sortOrder: 0,
   };
}

function toInboxItem(item: ApiInboxItem, actor: User): InboxItem {
   const issue = issueSnapshot(item);
   const details = item.details ?? {};
   return {
      id: item.id,
      identifier: issue?.identifier ?? '',
      title: item.title,
      content: item.body ?? item.title,
      type: notificationType(item),
      category: item.category,
      eventType: item.eventType,
      severity: item.severity,
      user: actor,
      actor: actorOf(item),
      timestamp: item.createdAt,
      read: item.read,
      archived: item.archived,
      issue,
      issueId: item.issueId,
      // A row that names a task the identifier join could not resolve is a
      // row about a task that was deleted since.
      issueDeleted: Boolean(item.issueId) && !item.issueIdentifier,
      commentId: detailString(details, ['commentId', 'comment_id']) ?? null,
      commentBody: detailString(details, ['commentBody', 'comment', 'excerpt']) ?? null,
      prompt: detailString(details, ['prompt', 'instructions', 'originalPrompt']) ?? null,
      approval: item.approvalId ? { id: item.approvalId } : undefined,
      goal: item.goalId ? { id: item.goalId } : undefined,
      plan: item.planId ? { id: item.planId } : undefined,
   };
}

/**
 * One page of the inbox. Throws when the request or the shape fails, so a
 * screen can tell an empty list from a list it could not read.
 */
export async function fetchInbox(
   workspaceId: string,
   actor: User,
   query: InboxQuery = {}
): Promise<InboxItem[]> {
   if (!workspaceId) return [];
   const params = new URLSearchParams({
      workspaceId,
      first: String(query.first ?? 50),
      state: query.state ?? 'active',
   });
   if (query.unreadOnly) params.set('unread', 'true');
   const json: unknown = await apiFetch(`/api/v1/inbox?${params.toString()}`);
   const parsed = inboxConnectionSchema.safeParse(json);
   if (!parsed.success) throw new Error('Inbox response was not recognized');
   return parsed.data.nodes.map((item) => toInboxItem(item, actor));
}

/**
 * The working inbox, or an empty list when it cannot be read.
 *
 * Hydration callers treat the inbox as a best-effort side channel: a failed
 * refresh must not take down the page it decorates. Screens that need to say
 * "this failed" call `fetchInbox` instead.
 */
export async function loadWorkspaceInbox(
   workspaceId: string,
   actor: User,
   query: InboxQuery = {}
): Promise<InboxItem[]> {
   try {
      return await fetchInbox(workspaceId, actor, query);
   } catch {
      return [];
   }
}

export async function updateInboxItem(
   workspaceId: string,
   itemId: string,
   action: InboxAction
): Promise<boolean> {
   if (!workspaceId || !itemId) return false;
   try {
      await apiFetch(`/api/v1/inbox/${encodeURIComponent(itemId)}/${action}`, {
         method: 'POST',
         body: JSON.stringify({ workspaceId }),
      });
      return true;
   } catch {
      return false;
   }
}

export async function bulkUpdateInbox(
   workspaceId: string,
   itemIds: string[],
   action: InboxAction
): Promise<boolean> {
   if (!workspaceId || itemIds.length === 0) return false;
   try {
      await apiFetch('/api/v1/inbox/bulk', {
         method: 'POST',
         body: JSON.stringify({ workspaceId, itemIds, action }),
      });
      return true;
   } catch {
      return false;
   }
}

export async function loadInboxUnreadCount(workspaceId: string): Promise<number> {
   if (!workspaceId) return 0;
   try {
      const params = new URLSearchParams({ workspaceId });
      const json: unknown = await apiFetch(`/api/v1/inbox/unread-count?${params.toString()}`);
      const parsed = z.object({ count: z.number() }).safeParse(json);
      return parsed.success ? parsed.data.count : 0;
   } catch {
      return 0;
   }
}
