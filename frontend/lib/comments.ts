import type { ActivityItem } from '@/data/issue-details';
import type { User } from '@/data/users';
import { formatDistanceToNow, parseISO } from 'date-fns';
import { z } from 'zod';
import { apiFetch } from './api';
import { actorRefSchema, connectionSchema, newIdempotencyKey } from './api-schemas';
import { toUiUser } from './catalog';

const commentSchema = z.object({
   id: z.string(),
   issueId: z.string(),
   body: z.string(),
   author: actorRefSchema,
   parentId: z.string().nullish(),
   revision: z.number(),
   resolvedAt: z.string().nullish(),
   resolvedBy: actorRefSchema.nullish(),
   createdAt: z.string(),
   updatedAt: z.string(),
});

const commentConnectionSchema = connectionSchema(commentSchema);

export type ApiComment = z.infer<typeof commentSchema>;

function timeAgo(iso: string): string {
   try {
      return formatDistanceToNow(parseISO(iso), { addSuffix: true });
   } catch {
      return 'recently';
   }
}

export function commentToActivityItem(comment: ApiComment): Extract<ActivityItem, { kind: 'comment' }> {
   const actor: User = toUiUser(comment.author);
   return {
      kind: 'comment',
      id: comment.id,
      actor,
      timeAgo: timeAgo(comment.createdAt),
      body: [{ type: 'paragraph', text: comment.body }],
   };
}

export async function loadIssueComments(issueRef: string): Promise<ApiComment[]> {
   const collected: ApiComment[] = [];
   let after: string | undefined;
   for (let page = 0; page < 20; page += 1) {
      const params = new URLSearchParams({ first: '50' });
      if (after) params.set('after', after);
      const json: unknown = await apiFetch(
         `/api/v1/issues/${encodeURIComponent(issueRef)}/comments?${params.toString()}`
      );
      const parsed = commentConnectionSchema.safeParse(json);
      if (!parsed.success) break;
      collected.push(...parsed.data.nodes);
      const { hasNextPage, endCursor } = parsed.data.pageInfo;
      if (!hasNextPage || !endCursor || parsed.data.nodes.length === 0) break;
      after = endCursor;
   }
   return collected;
}

export async function createIssueComment(issueRef: string, body: string): Promise<ApiComment> {
   const json: unknown = await apiFetch(
      `/api/v1/issues/${encodeURIComponent(issueRef)}/comments`,
      {
         method: 'POST',
         headers: { 'Idempotency-Key': newIdempotencyKey() },
         body: JSON.stringify({ body }),
      }
   );
   const parsed = commentSchema.safeParse(json);
   if (!parsed.success) {
      throw new Error('Create comment response was not recognized');
   }
   return parsed.data;
}
