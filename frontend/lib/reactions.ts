import { z } from 'zod';
import { apiFetch } from './api';
import { parseResponse } from './parse-response';

const groupSchema = z.object({
   emoji: z.string(),
   count: z.number(),
   reactedByMe: z.boolean(),
   actorIds: z.array(z.string()),
});
export type ReactionGroup = z.infer<typeof groupSchema>;
const groupsSchema = z.object({ nodes: z.array(groupSchema) });

/** The picker's fixed set: enough to react, without an emoji catalogue. */
export const QUICK_EMOJI = ['👍', '🎉', '❤️', '👀', '🚀', '😄'] as const;

type Target = 'issue' | 'comment';
const base = (target: Target, id: string) =>
   `/api/v1/${target === 'issue' ? 'issues' : 'comments'}/${encodeURIComponent(id)}/reactions`;

export async function loadReactions(target: Target, id: string): Promise<ReactionGroup[]> {
   return parseResponse(groupsSchema, await apiFetch(base(target, id)), 'Reactions').nodes;
}

/** Adds the reaction, or removes it when the viewer already reacted with it. */
export async function toggleReaction(
   target: Target,
   id: string,
   emoji: string,
   reacted: boolean
): Promise<ReactionGroup[]> {
   const json = reacted
      ? await apiFetch(`${base(target, id)}/${encodeURIComponent(emoji)}`, { method: 'DELETE' })
      : await apiFetch(base(target, id), { method: 'POST', body: JSON.stringify({ emoji }) });
   return parseResponse(groupsSchema, json, 'Reactions').nodes;
}
