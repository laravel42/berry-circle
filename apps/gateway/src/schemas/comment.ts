import { z } from "zod";
import { actorRefSchema, timestampSchema, uuidSchema } from "~/schemas/common";

/** Comment DTOs: the resource shape plus create/update bodies. */

export const commentSchema = z.object({
  id: uuidSchema,
  issueId: uuidSchema,
  body: z.string().min(1).max(100000),
  author: actorRefSchema,
  /** Parent comment for one-level threading; null for a root comment. */
  parentId: uuidSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type Comment = z.infer<typeof commentSchema>;

/**
 * `POST /api/v1/issues/{issueId}/comments` request body. The author is always
 * the authenticated actor and cannot be supplied by the client. A parent, when
 * given, MUST belong to the same issue and itself be a root comment.
 */
export const createCommentRequestSchema = z.object({
  body: z.string().min(1).max(100000),
  parentId: uuidSchema.nullable().default(null),
});
export type CreateCommentRequest = z.infer<typeof createCommentRequestSchema>;

/** `PATCH /api/v1/comments/{commentId}` request body. */
export const updateCommentRequestSchema = z.object({
  body: z.string().min(1).max(100000),
});
export type UpdateCommentRequest = z.infer<typeof updateCommentRequestSchema>;
