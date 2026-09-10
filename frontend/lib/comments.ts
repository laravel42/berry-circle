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
      comment,
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

export async function updateComment(commentId: string, body: string, revision: number): Promise<ApiComment> {
   const json: unknown = await apiFetch(`/api/v1/comments/${encodeURIComponent(commentId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ body, revision }),
   });
   const parsed = commentSchema.safeParse(json);
   if (!parsed.success) throw new Error('Edit comment response was not recognized');
   return parsed.data;
}

export async function deleteComment(commentId: string): Promise<void> {
   await apiFetch(`/api/v1/comments/${encodeURIComponent(commentId)}`, { method: 'DELETE' });
}

export async function setCommentResolved(commentId: string, resolved: boolean): Promise<ApiComment> {
   const json: unknown = await apiFetch(`/api/v1/comments/${encodeURIComponent(commentId)}/resolution`, {
      method: resolved ? 'POST' : 'DELETE',
   });
   const parsed = commentSchema.safeParse(json);
   if (!parsed.success) throw new Error('Resolve comment response was not recognized');
   return parsed.data;
}

// ------------------------------------------------------------ mentions

/**
 * A mention is an explicit token the composer writes — `@[Name](agent:<id>)` or
 * `@[Name](squad:<id>)` — never a guess from "@name" text, so it cannot start a
 * run nobody asked for and it survives a rename.
 */
const MENTION = /@\[([^\]\n]{1,100})\]\((agent|squad):([0-9a-fA-F-]{36})\)/g;

export function mentionToken(kind: 'agent' | 'squad', id: string, name: string): string {
   return `@[${name.replace(/[\]\n]/g, '').slice(0, 100)}](${kind}:${id})`;
}

export type MentionPart =
   | { text: string }
   | { mention: { kind: 'agent' | 'squad'; id: string; name: string } };

export function splitMentions(body: string): MentionPart[] {
   const parts: MentionPart[] = [];
   let last = 0;
   for (const match of body.matchAll(MENTION)) {
      const index = match.index ?? 0;
      if (index > last) parts.push({ text: body.slice(last, index) });
      parts.push({
         mention: { kind: match[2] as 'agent' | 'squad', id: match[3] ?? '', name: match[1] ?? '' },
      });
      last = index + match[0].length;
   }
   if (last < body.length) parts.push({ text: body.slice(last) });
   return parts;
}

const triggerPlanSchema = z.object({
   targets: z.array(
      z.object({
         agentId: z.string(),
         agentName: z.string(),
         reason: z.enum(['mention', 'squad_leader', 'reply_to_assignee']),
      })
   ),
   refused: z.array(
      z.object({ agentId: z.string(), agentName: z.string(), reason: z.literal('no_access') })
   ),
});
export type TriggerPlan = z.infer<typeof triggerPlanSchema>;

/** Which agents this comment would start if sent now. Writes nothing. */
export async function previewCommentTriggers(issueRef: string, body: string): Promise<TriggerPlan> {
   const json: unknown = await apiFetch(
      `/api/v1/issues/${encodeURIComponent(issueRef)}/comments/trigger-preview`,
      { method: 'POST', body: JSON.stringify({ body }) }
   );
   return triggerPlanSchema.parse(json);
}
