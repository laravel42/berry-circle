import type { View, ViewFilter, ViewType } from '@/data/views';
import type { User } from '@/data/users';
import { STATUS_BY_API } from '@/lib/catalog';
import { z } from 'zod';
import { apiFetch } from './api';
import { connectionSchema } from './api-schemas';

const savedViewSchema = z.object({
   id: z.string(),
   workspaceId: z.string(),
   ownerId: z.string(),
   name: z.string(),
   visibility: z.string(),
   definitionVersion: z.number(),
   query: z.unknown(),
   display: z.unknown(),
   revision: z.number(),
   createdAt: z.string(),
   updatedAt: z.string(),
});

const savedViewConnectionSchema = connectionSchema(savedViewSchema);

function parseViewFilter(query: unknown, currentUserId?: string): ViewFilter {
   if (!query || typeof query !== 'object') return {};
   const record = query as Record<string, unknown>;
   const filter: ViewFilter = {};

   if (record.assignedToMe === true && currentUserId) {
      filter.unassigned = false;
   }
   if (record.unassigned === true) {
      filter.unassigned = true;
   }
   if (Array.isArray(record.statuses)) {
      const statusIds = record.statuses
         .filter((value): value is string => typeof value === 'string')
         .map((apiStatus) => STATUS_BY_API[apiStatus] ?? apiStatus);
      if (statusIds.length > 0) filter.statusIds = statusIds;
   }
   if (Array.isArray(record.priorities)) {
      const priorityIds = record.priorities.filter(
         (value): value is string => typeof value === 'string'
      );
      if (priorityIds.length > 0) filter.priorityIds = priorityIds;
   }
   if (Array.isArray(record.labelIds)) {
      const labelIds = record.labelIds.filter((value): value is string => typeof value === 'string');
      if (labelIds.length > 0) filter.labelIds = labelIds;
   }

   return filter;
}

function viewTypeFromQuery(query: unknown): ViewType {
   if (query && typeof query === 'object') {
      const record = query as Record<string, unknown>;
      if (record.resourceType === 'project') return 'project';
   }
   return 'issue';
}

function iconFromDisplay(display: unknown): string {
   if (display && typeof display === 'object') {
      const record = display as Record<string, unknown>;
      if (typeof record.icon === 'string' && record.icon.trim()) return record.icon;
   }
   return '◆';
}

export function toUiView(
   saved: z.infer<typeof savedViewSchema>,
   owner: User,
   currentUserId?: string
): View {
   const query = saved.query;
   const filter = parseViewFilter(query, currentUserId);
   if (
      query &&
      typeof query === 'object' &&
      (query as Record<string, unknown>).assignedToMe === true &&
      currentUserId
   ) {
      // Assigned-to-me is handled at query time via issue-query; keep a marker filter.
      filter.unassigned = false;
   }

   return {
      id: saved.id,
      name: saved.name,
      description: saved.visibility === 'private' ? 'Private view' : 'Workspace view',
      icon: iconFromDisplay(saved.display),
      type: viewTypeFromQuery(query),
      owner,
      createdAt: saved.createdAt.slice(0, 10),
      updatedAt: saved.updatedAt.slice(0, 10),
      filter,
   };
}

export async function loadWorkspaceViews(workspaceId: string, owner: User): Promise<View[]> {
   if (!workspaceId) return [];
   const collected: View[] = [];
   try {
      let after: string | undefined;
      for (let page = 0; page < 20; page += 1) {
         const params = new URLSearchParams({
            workspaceId,
            first: '100',
         });
         if (after) params.set('after', after);
         const json: unknown = await apiFetch(`/api/v1/views?${params.toString()}`);
         const parsed = savedViewConnectionSchema.safeParse(json);
         if (!parsed.success) break;
         for (const node of parsed.data.nodes) {
            collected.push(toUiView(node, owner, owner.id));
         }
         const { hasNextPage, endCursor } = parsed.data.pageInfo;
         if (!hasNextPage || !endCursor || parsed.data.nodes.length === 0) break;
         after = endCursor;
      }
      return collected;
   } catch {
      return collected;
   }
}
