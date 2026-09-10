import type { Queryable } from '../db/pool.ts';
import { NotFound } from '../identity/errors.ts';

/**
 * Resolving closes a thread, so only a root comment resolves; the unique index
 * `comments_one_resolution_per_thread_key` keeps one resolution per thread.
 * Not an edit: the revision is left alone, so an open editor is not invalidated.
 */
export class NotAThreadRoot extends Error {
   constructor() {
      super('only a thread root can be resolved');
      this.name = 'NotAThreadRoot';
   }
}

export async function setCommentResolution(
   q: Queryable,
   input: { commentId: string; actorId: string; resolved: boolean }
): Promise<{ issueId: string; changed: boolean }> {
   const [row] = await q`
      SELECT issue_id, parent_id, resolved_at FROM comments WHERE id = ${input.commentId} FOR UPDATE`;
   if (!row) throw new NotFound();
   if (row.parent_id !== null) throw new NotAThreadRoot();
   const issueId = row.issue_id as string;
   const isResolved = row.resolved_at !== null;
   if (isResolved === input.resolved) return { issueId, changed: false };

   if (input.resolved) {
      await q`
         UPDATE comments SET resolved_at = now(), resolved_by = ${input.actorId}
          WHERE id = ${input.commentId}`;
   } else {
      await q`UPDATE comments SET resolved_at = NULL, resolved_by = NULL WHERE id = ${input.commentId}`;
   }
   return { issueId, changed: true };
}
