import { z } from "zod";
import { commentSchema } from "~/schemas/comment";
import { timestampSchema, uuidSchema } from "~/schemas/common";
import { issueSchema } from "~/schemas/issue";
import { runSchema, runUsageSchema } from "~/schemas/run";

/**
 * SSE event DTOs for the run and board streams.
 *
 * The gateway persists every event before delivery and emits the same shape on
 * replay and live. Payloads carry only redacted, client-safe data — never raw
 * prompts, reasoning, credentials, unredacted tool I/O, or filesystem paths.
 */

export const eventTypeSchema = z.enum([
  "run.created",
  "run.started",
  "run.output.delta",
  "run.tool.started",
  "run.tool.completed",
  "run.usage.updated",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "issue.updated",
  "comment.created",
]);
export type EventType = z.infer<typeof eventTypeSchema>;

// ---------- per-type payloads ----------

export const runCreatedPayloadSchema = z.object({ run: runSchema });
export const runStartedPayloadSchema = z.object({ startedAt: timestampSchema });
export const runOutputDeltaPayloadSchema = z.object({
  channel: z.enum(["progress", "final"]),
  text: z.string(),
});
export const runToolStartedPayloadSchema = z.object({
  toolCallId: z.string(),
  name: z.string(),
  inputSummary: z.string().nullable(),
});
export const runToolCompletedPayloadSchema = z.object({
  toolCallId: z.string(),
  status: z.enum(["succeeded", "failed"]),
  outputSummary: z.string().nullable(),
});
export const runUsageUpdatedPayloadSchema = z.object({ usage: runUsageSchema });
export const runCompletedPayloadSchema = z.object({ run: runSchema });
export const runFailedPayloadSchema = z.object({ run: runSchema });
export const runCancelledPayloadSchema = z.object({ run: runSchema });
export const issueUpdatedPayloadSchema = z.object({
  issue: issueSchema,
  changedFields: z.array(z.string()),
});
export const commentCreatedPayloadSchema = z.object({ comment: commentSchema });

/** Fields common to every event envelope, independent of `type`/`payload`. */
const eventBaseShape = {
  /** Opaque, globally unique event cursor (also the SSE `id` line). */
  id: z.string().min(1),
  occurredAt: timestampSchema,
  boardId: uuidSchema,
  issueId: uuidSchema,
  /** Run scope; null for comment-only events. */
  runId: uuidSchema.nullable(),
  /** Strictly increasing within a run; null for events without a run. */
  sequence: z.number().int().nonnegative().nullable(),
};

/**
 * Strict, fully-typed event envelope: a discriminated union on `type` that ties
 * each event type to its payload shape. Use this to build/serialize events and
 * to narrow a known event.
 */
export const eventSchema = z.discriminatedUnion("type", [
  z.object({ ...eventBaseShape, type: z.literal("run.created"), payload: runCreatedPayloadSchema }),
  z.object({ ...eventBaseShape, type: z.literal("run.started"), payload: runStartedPayloadSchema }),
  z.object({
    ...eventBaseShape,
    type: z.literal("run.output.delta"),
    payload: runOutputDeltaPayloadSchema,
  }),
  z.object({
    ...eventBaseShape,
    type: z.literal("run.tool.started"),
    payload: runToolStartedPayloadSchema,
  }),
  z.object({
    ...eventBaseShape,
    type: z.literal("run.tool.completed"),
    payload: runToolCompletedPayloadSchema,
  }),
  z.object({
    ...eventBaseShape,
    type: z.literal("run.usage.updated"),
    payload: runUsageUpdatedPayloadSchema,
  }),
  z.object({
    ...eventBaseShape,
    type: z.literal("run.completed"),
    payload: runCompletedPayloadSchema,
  }),
  z.object({ ...eventBaseShape, type: z.literal("run.failed"), payload: runFailedPayloadSchema }),
  z.object({
    ...eventBaseShape,
    type: z.literal("run.cancelled"),
    payload: runCancelledPayloadSchema,
  }),
  z.object({
    ...eventBaseShape,
    type: z.literal("issue.updated"),
    payload: issueUpdatedPayloadSchema,
  }),
  z.object({
    ...eventBaseShape,
    type: z.literal("comment.created"),
    payload: commentCreatedPayloadSchema,
  }),
]);
export type Event = z.infer<typeof eventSchema>;

/**
 * Loose, forward-compatible envelope for *parsing* an incoming stream, where
 * clients MUST ignore unknown event types. It validates the common fields and
 * keeps `type` a plain string and `payload` an open object, so an unrecognized
 * future event type still parses instead of throwing. Narrow to a known event
 * with {@link eventSchema} once `type` is recognized.
 */
export const eventEnvelopeSchema = z.object({
  ...eventBaseShape,
  type: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
});
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;
