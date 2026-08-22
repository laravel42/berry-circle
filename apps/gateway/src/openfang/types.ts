/**
 * Upstream OpenFang contract shapes (BERR-20).
 *
 * These schemas mirror the pinned upstream contract in
 * `docs/api/openfang-gateway-consumption.md` (commit
 * `acf2587e46be174c10200489c9a2d23a39a98aeb`, v0.6.9). Field names stay
 * `snake_case` to match the wire exactly — this adapter is the faithful upstream
 * boundary, and the gateway's public DTO layer (BERR-22/23/26) maps these to
 * Berry's camel-case API. Any drift here is an upstream contract change and must
 * move together with the doc and the adapter tests.
 *
 * Response schemas are intentionally strict on documented fields (so contract
 * tests pin the shape) but tolerant of extra keys — Zod strips unknown keys by
 * default, so an additive upstream change does not break the adapter.
 */

import { z } from "zod";

/** Message body cap on the streaming dispatch endpoint: 64 KiB, in bytes. */
export const MESSAGE_MAX_BYTES = 64 * 1024;
/** Manifest cap on agent spawn: 1 MiB, in bytes. */
export const MANIFEST_MAX_BYTES = 1024 * 1024;

// ---------------------------------------------------------------------------
// Agent lifecycle
// ---------------------------------------------------------------------------

export const agentIdentitySummarySchema = z.object({
  emoji: z.string().nullable(),
  avatar_url: z.string().nullable(),
  color: z.string().nullable(),
});

/**
 * `state` and `mode` are left as open strings rather than enums: the pinned
 * server emits Debug-form casing (`Running`, `Suspended`, …) that Berry passes
 * through verbatim, and a future upstream state must not hard-fail the adapter.
 */
export const agentSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  state: z.string(),
  mode: z.string(),
  created_at: z.string(),
  last_active: z.string(),
  model_provider: z.string(),
  model_name: z.string(),
  model_tier: z.string(),
  auth_status: z.string(),
  ready: z.boolean(),
  is_inferencing: z.boolean(),
  profile: z.string().nullable(),
  identity: agentIdentitySummarySchema,
});
export type AgentSummary = z.infer<typeof agentSummarySchema>;

export const agentListSchema = z.array(agentSummarySchema);

export const agentDetailSchema = z.object({
  id: z.string(),
  name: z.string(),
  state: z.string(),
  mode: z.string(),
  profile: z.string().nullable(),
  created_at: z.string(),
  session_id: z.string(),
  model: z.object({ provider: z.string(), model: z.string() }),
  capabilities: z.object({ tools: z.array(z.string()), network: z.array(z.string()) }),
  description: z.string(),
  system_prompt: z.string(),
  tags: z.array(z.string()),
  identity: z.object({
    emoji: z.string().nullable(),
    avatar_url: z.string().nullable(),
    color: z.string().nullable(),
    archetype: z.string().nullable(),
    vibe: z.string().nullable(),
    greeting_style: z.string().nullable(),
  }),
  skills: z.array(z.unknown()),
  skills_mode: z.string(),
  mcp_servers: z.array(z.unknown()),
  mcp_servers_mode: z.string(),
  fallback_models: z.array(z.unknown()),
});
export type AgentDetail = z.infer<typeof agentDetailSchema>;

export const spawnAgentResponseSchema = z.object({
  agent_id: z.string(),
  name: z.string(),
});
export type SpawnAgentResponse = z.infer<typeof spawnAgentResponseSchema>;

export const patchAgentResponseSchema = z.object({
  status: z.string(),
  agent_id: z.string(),
  name: z.string(),
});
export type PatchAgentResponse = z.infer<typeof patchAgentResponseSchema>;

export const killAgentResponseSchema = z.object({
  status: z.string(),
  agent_id: z.string(),
});
export type KillAgentResponse = z.infer<typeof killAgentResponseSchema>;

/**
 * Spawn request. Exactly one usable manifest source is required: a non-empty
 * `manifest_toml`, or a `template` name when the manifest string is empty.
 */
export const spawnAgentRequestSchema = z
  .object({
    manifest_toml: z.string().optional(),
    template: z.string().optional(),
    signed_manifest: z.string().optional(),
  })
  .refine(
    (body) =>
      (body.manifest_toml !== undefined && body.manifest_toml.length > 0) ||
      (body.template !== undefined && body.template.length > 0),
    { message: "provide a non-empty manifest_toml or a template" },
  )
  .refine(
    (body) =>
      body.manifest_toml === undefined || byteLength(body.manifest_toml) <= MANIFEST_MAX_BYTES,
    { message: "manifest_toml exceeds 1 MiB", path: ["manifest_toml"] },
  );
export type SpawnAgentRequest = z.infer<typeof spawnAgentRequestSchema>;

/**
 * Partial agent update. `.strict()` implements the contract's allowlist: the
 * pinned handler silently ignores unknown fields, so the adapter rejects them
 * up front to keep typos from being accepted. `provider` is only meaningful
 * alongside `model`.
 */
export const patchAgentRequestSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    model: z.string().optional(),
    provider: z.string().optional(),
    system_prompt: z.string().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: "patch requires at least one field",
  })
  .refine((body) => body.provider === undefined || body.model !== undefined, {
    message: "provider requires model",
    path: ["provider"],
  });
export type PatchAgentRequest = z.infer<typeof patchAgentRequestSchema>;

// ---------------------------------------------------------------------------
// Agent execution, runs, and streaming
// ---------------------------------------------------------------------------

export const messageStreamRequestSchema = z
  .object({
    message: z.string(),
    attachments: z.array(z.unknown()).optional(),
    sender_id: z.string().nullable().optional(),
    sender_name: z.string().nullable().optional(),
  })
  .refine((body) => byteLength(body.message) <= MESSAGE_MAX_BYTES, {
    message: "message exceeds 64 KiB",
    path: ["message"],
  });
export type MessageStreamRequest = z.infer<typeof messageStreamRequestSchema>;

/**
 * Stop can return the plain kernel shape or, for a hand-owned agent, additional
 * `hand_*` fields — both are accepted.
 */
export const stopAgentResponseSchema = z.object({
  status: z.string(),
  message: z.string(),
  hand_deactivated: z.boolean().optional(),
  hand_id: z.string().optional(),
  instance_id: z.string().optional(),
});
export type StopAgentResponse = z.infer<typeof stopAgentResponseSchema>;

export const sessionToolSchema = z.object({
  name: z.string(),
  input: z.unknown(),
  running: z.boolean(),
  expanded: z.boolean(),
  result: z.unknown().optional(),
  is_error: z.boolean().optional(),
});

export const sessionMessageSchema = z.object({
  role: z.string(),
  content: z.string(),
  tools: z.array(sessionToolSchema).optional(),
  images: z.array(z.object({ file_id: z.string(), filename: z.string() })).optional(),
});
export type SessionMessage = z.infer<typeof sessionMessageSchema>;

export const agentSessionSchema = z.object({
  session_id: z.string(),
  agent_id: z.string(),
  message_count: z.number().int(),
  raw_message_count: z.number().int().optional(),
  context_window_tokens: z.number().int(),
  label: z.string().nullable().optional(),
  messages: z.array(sessionMessageSchema),
});
export type AgentSession = z.infer<typeof agentSessionSchema>;

export const auditEntrySchema = z.object({
  seq: z.number().int(),
  timestamp: z.string(),
  agent_id: z.string().nullable(),
  action: z.string(),
  detail: z.string(),
  outcome: z.string(),
  hash: z.string(),
});

export const auditPageSchema = z.object({
  entries: z.array(auditEntrySchema),
  total: z.number().int(),
  tip_hash: z.string().nullable(),
});
export type AuditPage = z.infer<typeof auditPageSchema>;

export const usageByAgentSchema = z.object({
  agents: z.array(
    z.object({
      agent_id: z.string(),
      name: z.string(),
      total_tokens: z.number(),
      tool_calls: z.number(),
    }),
  ),
});
export type UsageByAgent = z.infer<typeof usageByAgentSchema>;

// ---------------------------------------------------------------------------
// Memory (shared global namespace despite the {agentId} path)
// ---------------------------------------------------------------------------

export const kvPairSchema = z.object({ key: z.string(), value: z.unknown() });
export type KvPair = z.infer<typeof kvPairSchema>;

export const kvListResponseSchema = z.object({ kv_pairs: z.array(kvPairSchema) });
export type KvListResponse = z.infer<typeof kvListResponseSchema>;

export const memoryMutationResponseSchema = z.object({
  status: z.string(),
  key: z.string(),
});
export type MemoryMutationResponse = z.infer<typeof memoryMutationResponseSchema>;

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

export const workflowStepModeSchema = z.enum([
  "sequential",
  "fan_out",
  "collect",
  "conditional",
  "loop",
]);
export const workflowErrorModeSchema = z.enum(["fail", "skip", "retry"]);

/**
 * Flat write DTO. The adapter fills every documented default and validates
 * enums/ranges before dispatch because the pinned handler silently coerces
 * invalid or missing values. Each step needs an `agent_id` or `agent_name`.
 */
export const workflowStepInputSchema = z
  .object({
    name: z.string().default("step"),
    agent_id: z.string().optional(),
    agent_name: z.string().optional(),
    prompt: z.string().default("{{input}}"),
    mode: workflowStepModeSchema.default("sequential"),
    condition: z.string().default(""),
    max_iterations: z.number().int().positive().default(5),
    until: z.string().default(""),
    timeout_secs: z.number().int().positive().default(120),
    error_mode: workflowErrorModeSchema.default("fail"),
    max_retries: z.number().int().nonnegative().default(3),
    output_var: z.string().optional(),
  })
  .refine((step) => step.agent_id !== undefined || step.agent_name !== undefined, {
    message: "each step needs agent_id or agent_name",
  });
export type WorkflowStepInput = z.input<typeof workflowStepInputSchema>;

export const workflowWriteRequestSchema = z.object({
  name: z.string().default("unnamed"),
  description: z.string().default(""),
  steps: z.array(workflowStepInputSchema).min(1, "workflow requires at least one step"),
});
export type WorkflowWriteRequest = z.input<typeof workflowWriteRequestSchema>;

export const workflowSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  steps: z.number().int(),
  created_at: z.string(),
});
export type WorkflowSummary = z.infer<typeof workflowSummarySchema>;

/**
 * Read step shape is asymmetric with the write DTO: `agent` is `{ id }` or
 * `{ name }`, `prompt_template` replaces `prompt`, and parameterized enum
 * variants serialize as nested objects. It is kept loose here (documented hints
 * plus passthrough) because the gateway DTO layer owns the normalization.
 */
export const workflowReadStepSchema = z
  .object({
    name: z.string().optional(),
    agent: z.union([z.object({ id: z.string() }), z.object({ name: z.string() })]).optional(),
    prompt_template: z.string().optional(),
  })
  .passthrough();
export type WorkflowReadStep = z.infer<typeof workflowReadStepSchema>;

export const workflowDetailSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  steps: z.array(workflowReadStepSchema),
  created_at: z.string(),
});
export type WorkflowDetail = z.infer<typeof workflowDetailSchema>;

export const createWorkflowResponseSchema = z.object({ workflow_id: z.string() });
export type CreateWorkflowResponse = z.infer<typeof createWorkflowResponseSchema>;

export const workflowMutationResponseSchema = z.object({
  status: z.string(),
  workflow_id: z.string(),
});
export type WorkflowMutationResponse = z.infer<typeof workflowMutationResponseSchema>;

export const workflowRunRequestSchema = z.object({ input: z.string().default("") });
export type WorkflowRunRequest = z.input<typeof workflowRunRequestSchema>;

export const workflowRunResponseSchema = z.object({
  run_id: z.string(),
  output: z.string(),
  status: z.string(),
});
export type WorkflowRunResponse = z.infer<typeof workflowRunResponseSchema>;

/** Documented run states, for reference by consumers that narrow `state`. */
export const WORKFLOW_RUN_STATES = ["pending", "running", "completed", "failed"] as const;

export const workflowRunSummarySchema = z.object({
  id: z.string(),
  workflow_name: z.string(),
  // Open string rather than a strict enum: this endpoint is reconciliation
  // evidence and `parseResponse` validates the whole array, so a single run with
  // an additive upstream state must not hard-fail (and drop) the entire page.
  // Mirrors the deliberately-open agent `state`/`mode` above; the raw value is
  // preserved verbatim for the caller to narrow against `WORKFLOW_RUN_STATES`.
  state: z.string(),
  steps_completed: z.number().int(),
  started_at: z.string(),
  completed_at: z.string().nullable(),
});
export type WorkflowRunSummary = z.infer<typeof workflowRunSummarySchema>;

export const workflowRunListSchema = z.array(workflowRunSummarySchema);

/** UTF-8 byte length, used to enforce the byte-based upstream size caps. */
export function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}
