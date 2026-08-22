import { z } from "zod";
import { paginationQuerySchema, timestampSchema, uuidSchema } from "~/schemas/common";
import { agentStatusSchema } from "~/schemas/enums";

/**
 * Agent DTOs. Agents are read-only in v1; the gateway never exposes provider
 * configuration, credentials, system prompts, or raw runtime payloads.
 */

export const agentSchema = z.object({
  id: uuidSchema,
  name: z.string().min(1).max(100),
  description: z.string().max(5000).nullable(),
  avatarUrl: z.string().url().nullable(),
  status: agentStatusSchema,
  /** Sorted, unique capability identifiers. */
  capabilities: z.array(z.string()),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type Agent = z.infer<typeof agentSchema>;

/** `GET /api/v1/agents` query parameters. */
export const agentListQuerySchema = paginationQuerySchema.extend({
  status: agentStatusSchema.optional(),
});
export type AgentListQuery = z.infer<typeof agentListQuerySchema>;
