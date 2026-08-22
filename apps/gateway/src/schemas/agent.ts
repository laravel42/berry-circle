import { z } from "zod";
import {
  httpUrlSchema,
  paginationQuerySchema,
  timestampSchema,
  uuidSchema,
} from "~/schemas/common";
import { agentStatusSchema } from "~/schemas/enums";

/**
 * Agent DTOs. Agents are read-only in v1; the gateway never exposes provider
 * configuration, credentials, system prompts, or raw runtime payloads.
 */

export const agentSchema = z.object({
  id: uuidSchema,
  name: z.string().min(1).max(100),
  description: z.string().max(5000).nullable(),
  avatarUrl: httpUrlSchema.nullable(),
  status: agentStatusSchema,
  /** Unique capability identifiers (the gateway emits them sorted). */
  capabilities: z.array(z.string()).refine((caps) => new Set(caps).size === caps.length, {
    message: "Capabilities must be unique.",
  }),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type Agent = z.infer<typeof agentSchema>;

/** `GET /api/v1/agents` query parameters. */
export const agentListQuerySchema = paginationQuerySchema.extend({
  status: agentStatusSchema.optional(),
});
export type AgentListQuery = z.infer<typeof agentListQuerySchema>;
