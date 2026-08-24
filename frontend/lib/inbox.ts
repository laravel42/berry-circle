import type { InboxItem, NotificationType } from '@/data/inbox';
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
});

const inboxConnectionSchema = connectionSchema(inboxSchema);

function notificationType(eventType: string, category: string): NotificationType {
   const haystack = `${eventType} ${category}`.toLowerCase();
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
      const fallbackStatus = catalogStatus('backlog');
      const fallbackPriority = catalogPriority('no-priority');
      if (!fallbackStatus || !fallbackPriority) return [];

      return parsed.data.nodes.map((item) => {
         const status = item.issueStatus
            ? (uiStatusFromApi(item.issueStatus) ?? fallbackStatus)
            : fallbackStatus;
         return {
            id: item.id,
            // The server derives this from the issue's board slug and number.
            // The old fallback sliced the issue UUID, so every row read
            // "11111111"; an empty label is better than a wrong one.
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
            content: item.body ?? item.title,
            type: notificationType(item.eventType, item.category),
            user: actor,
            timestamp: item.createdAt,
            read: item.read,
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
