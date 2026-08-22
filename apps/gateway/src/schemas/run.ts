import { z } from "zod";
import { paginationQuerySchema, timestampSchema, uuidSchema } from "~/schemas/common";
import { runStatusSchema } from "~/schemas/enums";

/** Run DTOs: the resource shape, its nested usage/failure, and the dispatch body. */

/** Cumulative normalized token/cost usage for a run. */
export const runUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  /** Non-negative millionths of the billing currency; null when unavailable. */
  costMicros: z.number().int().nonnegative().nullable(),
  /** ISO 4217 uppercase code; null with an unavailable cost. */
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/, "Currency must be an ISO 4217 uppercase code.")
    .nullable(),
});
export type RunUsage = z.infer<typeof runUsageSchema>;

/** Present only when a run's `status` is `failed`. */
export const runFailureSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
});
export type RunFailure = z.infer<typeof runFailureSchema>;

export const runSchema = z.object({
  /** Berry run ID; never a provider run ID. */
  id: uuidSchema,
  issueId: uuidSchema,
  agentId: uuidSchema,
  status: runStatusSchema,
  /** Latest persisted event sequence, starting at 0. */
  sequence: z.number().int().nonnegative(),
  summary: z.string().nullable(),
  usage: runUsageSchema,
  failure: runFailureSchema.nullable(),
  createdAt: timestampSchema,
  startedAt: timestampSchema.nullable(),
  completedAt: timestampSchema.nullable(),
});
export type Run = z.infer<typeof runSchema>;

/**
 * `POST /api/v1/issues/{issueId}/runs` request body. `agentId`, when present,
 * atomically assigns that agent before dispatch; otherwise the current assignee
 * is used. An empty body is valid.
 */
export const createRunRequestSchema = z.object({
  agentId: uuidSchema.nullable().default(null),
  instructions: z.string().max(20000).nullable().default(null),
});
export type CreateRunRequest = z.infer<typeof createRunRequestSchema>;

/** `GET /api/v1/issues/{issueId}/runs` query parameters. */
export const runListQuerySchema = paginationQuerySchema.extend({
  status: runStatusSchema.optional(),
});
export type RunListQuery = z.infer<typeof runListQuerySchema>;
