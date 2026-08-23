import { z } from "zod";

/**
 * Domain enums shared across resource DTOs.
 *
 * These use the *contract* (public API) spelling in `camelCase`
 * (`inProgress`, `inReview`), which deliberately differs from the Postgres
 * enum storage spelling (`in_progress`, `in_review` in `src/db/schema.ts`).
 * Mapping between the two is the route layer's job — do not "fix" these to
 * match the database.
 */

/** Issue workflow state. */
export const issueStatusSchema = z.enum([
  "backlog",
  "todo",
  "inProgress",
  "inReview",
  "done",
  "blocked",
  "cancelled",
]);
export type IssueStatus = z.infer<typeof issueStatusSchema>;

/** Issue scheduling priority. */
export const issuePrioritySchema = z.enum(["none", "urgent", "high", "medium", "low"]);
export type IssuePriority = z.infer<typeof issuePrioritySchema>;

/**
 * Normalized agent availability. `unknown` is the required client fallback for
 * an unrecognized upstream state.
 */
export const agentStatusSchema = z.enum(["available", "busy", "offline", "unknown"]);
export type AgentStatus = z.infer<typeof agentStatusSchema>;

/** Normalized run lifecycle state. */
export const runStatusSchema = z.enum(["queued", "running", "succeeded", "failed", "cancelled"]);
export type RunStatus = z.infer<typeof runStatusSchema>;

/** Run statuses that count as active (at most one active run per issue). */
export const ACTIVE_RUN_STATUSES = ["queued", "running"] as const satisfies readonly RunStatus[];

/** Run statuses that are terminal (immutable except late usage reconciliation). */
export const TERMINAL_RUN_STATUSES = [
  "succeeded",
  "failed",
  "cancelled",
] as const satisfies readonly RunStatus[];

export const isActiveRunStatus = (status: RunStatus): boolean =>
  (ACTIVE_RUN_STATUSES as readonly RunStatus[]).includes(status);

export const isTerminalRunStatus = (status: RunStatus): boolean =>
  (TERMINAL_RUN_STATUSES as readonly RunStatus[]).includes(status);
