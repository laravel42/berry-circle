import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Queryable } from '../db/pool.ts';

/** Mirrors the table CHECKs, so a refusal is a 422 rather than a 500. */
export const emojiSchema = z
   .string()
   .min(1)
   .max(16)
   .refine((value) => !/[\p{Cc}\s]/u.test(value) && Buffer.byteLength(value, 'utf8') <= 64, {
      message: 'A reaction is a single emoji.',
   });

export interface ReactionGroup {
   emoji: string;
   count: number;
   reactedByMe: boolean;
   actorIds: string[];
}

export type ReactionTarget = 'issue' | 'comment';

function group(rows: ReadonlyArray<Record<string, unknown>>, viewerId: string): ReactionGroup[] {
   return rows.map((row) => {
      const actorIds = (row.actors as string[]).map((id) => id.toLowerCase());
      return {
         emoji: row.emoji as string,
         count: actorIds.length,
         reactedByMe: actorIds.includes(viewerId.toLowerCase()),
         actorIds,
      };
   });
}

export async function listReactions(
   q: Queryable,
   target: ReactionTarget,
   targetId: string,
   viewerId: string
): Promise<ReactionGroup[]> {
   const rows =
      target === 'issue'
         ? await q`
              SELECT emoji, array_agg(actor_id::text ORDER BY created_at, id) AS actors,
                     min(created_at) AS first_at
                FROM issue_reactions WHERE issue_id = ${targetId}
               GROUP BY emoji ORDER BY first_at, emoji`
         : await q`
              SELECT emoji, array_agg(actor_id::text ORDER BY created_at, id) AS actors,
                     min(created_at) AS first_at
                FROM comment_reactions WHERE comment_id = ${targetId}
               GROUP BY emoji ORDER BY first_at, emoji`;
   return group(rows, viewerId);
}

/** True when this reaction is new. Reacting again is a no-op, not an error. */
export async function addReaction(
   q: Queryable,
   target: ReactionTarget,
   targetId: string,
   actorId: string,
   emoji: string
): Promise<boolean> {
   const rows =
      target === 'issue'
         ? await q`
              INSERT INTO issue_reactions (id, issue_id, actor_id, emoji)
              VALUES (${randomUUID()}, ${targetId}, ${actorId}, ${emoji})
              ON CONFLICT (issue_id, actor_id, emoji) DO NOTHING RETURNING id`
         : await q`
              INSERT INTO comment_reactions (id, comment_id, actor_id, emoji)
              VALUES (${randomUUID()}, ${targetId}, ${actorId}, ${emoji})
              ON CONFLICT (comment_id, actor_id, emoji) DO NOTHING RETURNING id`;
   return rows.length === 1;
}

export async function removeReaction(
   q: Queryable,
   target: ReactionTarget,
   targetId: string,
   actorId: string,
   emoji: string
): Promise<boolean> {
   const rows =
      target === 'issue'
         ? await q`
              DELETE FROM issue_reactions
               WHERE issue_id = ${targetId} AND actor_id = ${actorId} AND emoji = ${emoji} RETURNING id`
         : await q`
              DELETE FROM comment_reactions
               WHERE comment_id = ${targetId} AND actor_id = ${actorId} AND emoji = ${emoji} RETURNING id`;
   return rows.length === 1;
}
