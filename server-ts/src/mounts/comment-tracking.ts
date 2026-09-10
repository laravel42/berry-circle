import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthVariables } from '../auth/middleware.ts';
import { serializeComment, type CommentRepository } from '../core/comments.ts';
import type { Sql } from '../db/pool.ts';
import { json } from '../http/app.ts';
import { ApiError } from '../http/errors.ts';
import type { Broadcaster } from '../realtime/hub.ts';
import { setCommentResolution } from '../work/comment-resolution.ts';
import { parseJsonBody } from '../work/http.ts';
import { publishEvents, recordIssueEvent } from '../work/outbox.ts';
import { addReaction, emojiSchema, listReactions, removeReaction } from '../work/reactions.ts';
import { pathId } from './shared.ts';
import { rethrowWork } from './work-errors.ts';

/** Reactions and thread resolution on a comment, under `/api/v1/comments`. */
const emojiBody = z.object({ emoji: emojiSchema }).strict();

export function commentTrackingRoutes(options: {
   sql: Sql;
   comments: CommentRepository;
   broadcaster?: Broadcaster | undefined;
}): Hono<{ Variables: AuthVariables }> {
   const { sql, comments } = options;
   const route = new Hono<{ Variables: AuthVariables }>();
   const asComment = rethrowWork('Comment');

   const load = async (raw: string | undefined, userId: string, permission: 'product.read' | 'comments.write') => {
      const commentId = pathId(raw, 'Comment');
      await comments.authorize(userId, commentId, permission).catch(asComment);
      return comments.get(commentId).catch(asComment);
   };
   const record = async (issueId: string, userId: string, type: string, payload: Record<string, unknown>) => {
      const event = await recordIssueEvent(sql, { issueId, type, actor: { type: 'user', id: userId }, payload });
      await publishEvents(options.broadcaster, [event]);
   };

   route.get('/:commentId/reactions', async (context) => {
      const userId = context.get('user').id;
      const comment = await load(context.req.param('commentId'), userId, 'product.read');
      return json({ nodes: await listReactions(sql, 'comment', comment.id, userId) });
   });

   route.post('/:commentId/reactions', async (context) => {
      const userId = context.get('user').id;
      const comment = await load(context.req.param('commentId'), userId, 'comments.write');
      const { emoji } = await parseJsonBody(context.req.raw, emojiBody);
      if (await addReaction(sql, 'comment', comment.id, userId, emoji)) {
         await record(comment.issueId, userId, 'comment.reactions.changed', { commentId: comment.id, emoji, added: true });
      }
      return json({ nodes: await listReactions(sql, 'comment', comment.id, userId) });
   });

   route.delete('/:commentId/reactions/:emoji', async (context) => {
      const userId = context.get('user').id;
      const comment = await load(context.req.param('commentId'), userId, 'comments.write');
      const emoji = emojiSchema.safeParse(context.req.param('emoji') ?? '');
      if (!emoji.success) throw ApiError.notFound('Reaction');
      if (await removeReaction(sql, 'comment', comment.id, userId, emoji.data)) {
         await record(comment.issueId, userId, 'comment.reactions.changed', { commentId: comment.id, emoji: emoji.data, added: false });
      }
      return json({ nodes: await listReactions(sql, 'comment', comment.id, userId) });
   });

   for (const [method, resolved] of [
      ['post', true],
      ['delete', false],
   ] as const) {
      route[method]('/:commentId/resolution', async (context) => {
         const userId = context.get('user').id;
         const comment = await load(context.req.param('commentId'), userId, 'comments.write');
         const result = await sql
            .begin((tx) => setCommentResolution(tx, { commentId: comment.id, actorId: userId, resolved }))
            .catch(asComment);
         if (result.changed) {
            await record(result.issueId, userId, resolved ? 'comment.resolved' : 'comment.unresolved', { commentId: comment.id });
         }
         return json(serializeComment(await comments.get(comment.id)));
      });
   }

   return route;
}
