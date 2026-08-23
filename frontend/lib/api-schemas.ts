import { z } from 'zod';

/** Cursor page metadata shared by `/api/v1` list endpoints. */
export const pageInfoSchema = z.object({
   hasNextPage: z.boolean(),
   endCursor: z.string().nullable(),
});

export const actorRefSchema = z.object({
   type: z.enum(['user', 'agent']),
   id: z.string(),
   name: z.string(),
   avatarUrl: z.string().nullable(),
});

export function connectionSchema<T extends z.ZodType>(node: T) {
   return z.object({
      nodes: z.array(node),
      pageInfo: pageInfoSchema,
   });
}

/** Visible ASCII idempotency key accepted by creating POSTs. */
export function newIdempotencyKey(): string {
   return crypto.randomUUID();
}
