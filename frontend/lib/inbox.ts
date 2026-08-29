import type { InboxItem, NotificationType } from '@/data/inbox';
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
});

const inboxConnectionSchema = connectionSchema(inboxSchema);

type ApiInboxItem = z.infer<typeof inboxSchema>;

function notificationType(item: ApiInboxItem): NotificationType {
   if (item.approvalId || item.category === 'approvals' || item.eventType.startsWith('approval.')) {
      return 'approval';
   }
   if (item.planId || item.eventType.startsWith('plan.')) return 'plan';
   if (item.goalId && !item.issueId) return 'goal';
   if (item.eventType.startsWith('goal.')) return 'goal';
   const haystack = `${item.eventType} ${item.category}`.toLowerCase();
   if (haystack.includes('comment')) return 'comment';
   if (haystack.includes('mention')) return 'mention';
   if (haystack.includes('assign')) return 'assignment';
   if (haystack.includes('status')) return 'status';
   if (haystack.includes('reopen')) return 'reopened';
   if (haystack.includes('close') || haystack.includes('done')) return 'closed';
   if (haystack.includes('edit') || haystack.includes('update')) return 'edited';
   if (haystack.includes('upload') || haystack.includes('attach')) return 'upload';
   return 'created';
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

export async function loadWorkspaceInbox(workspaceId: string, actor: User): Promise<InboxItem[]> {
   if (!workspaceId) return [];
   try {
      const params = new URLSearchParams({
         workspaceId,
         first: '50',
         state: 'active',
      });
      const json: unknown = await apiFetch(`/api/v1/inbox?${params.toString()}`);
      const parsed = inboxConnectionSchema.safeParse(json);
      if (!parsed.success) return [];

      return parsed.data.nodes.map((item) => {
         const issue = issueSnapshot(item);
         return {
            id: item.id,
            identifier: issue?.identifier ?? '',
            title: item.title,
            content: item.body ?? item.title,
            type: notificationType(item),
            category: item.category,
            user: actor,
            timestamp: item.createdAt,
            read: item.read,
            issue,
            approval: item.approvalId ? { id: item.approvalId } : undefined,
            goal: item.goalId ? { id: item.goalId } : undefined,
            plan: item.planId ? { id: item.planId } : undefined,
         };
      });
   } catch {
      return [];
   }
}

export async function updateInboxItem(
   workspaceId: string,
   itemId: string,
   action: 'read' | 'unread' | 'archive' | 'unarchive'
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
   action: 'read' | 'unread' | 'archive' | 'unarchive'
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
