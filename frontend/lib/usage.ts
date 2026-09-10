import { z } from 'zod';
import { apiFetch } from './api';

/**
 * Usage and dashboard reads. Money arrives as integer USD micros and tokens as
 * integers; formatting happens here, once, so every panel says the same thing.
 */

const bucketSchema = z.object({
   key: z.string(),
   events: z.number(),
   unpricedEvents: z.number(),
   inputTokens: z.number(),
   outputTokens: z.number(),
   cacheReadTokens: z.number(),
   cacheWriteTokens: z.number(),
   costMicros: z.number(),
});

const agentBucketSchema = bucketSchema.extend({ agentName: z.string() });

const windowSchema = z.object({
   currency: z.literal('USD'),
   days: z.number(),
   from: z.string(),
   to: z.string(),
});

const workspaceUsageSchema = windowSchema.extend({
   totals: bucketSchema,
   daily: z.array(bucketSchema),
   byAgent: z.array(agentBucketSchema),
   byModel: z.array(bucketSchema),
});

const agentUsageSchema = windowSchema.extend({
   totals: bucketSchema,
   daily: z.array(bucketSchema),
   byModel: z.array(bucketSchema),
});

const runtimeUsageSchema = windowSchema.extend({
   totals: bucketSchema,
   daily: z.array(bucketSchema),
   byAgent: z.array(agentBucketSchema),
   byHour: z.array(bucketSchema),
});

const issueUsageSchema = z.object({
   currency: z.literal('USD'),
   totals: bucketSchema,
   byRun: z.array(bucketSchema),
   byModel: z.array(bucketSchema),
});

const dashboardSchema = windowSchema.extend({
   usageDaily: z.array(bucketSchema),
   runsDaily: z.array(
      z.object({
         day: z.string(),
         total: z.number(),
         succeeded: z.number(),
         failed: z.number(),
         cancelled: z.number(),
      })
   ),
   failuresByAgent: z.array(
      z.object({
         agentId: z.string(),
         agentName: z.string(),
         failed: z.number(),
         total: z.number(),
      })
   ),
   runCounts: z.object({
      queued: z.number(),
      running: z.number(),
      succeeded: z.number(),
      failed: z.number(),
      cancelled: z.number(),
   }),
   workingAgents: z.array(
      z.object({
         runId: z.string(),
         agentId: z.string(),
         agentName: z.string(),
         issueId: z.string(),
         issueTitle: z.string(),
         startedAt: z.string().nullable(),
      })
   ),
   taskSnapshot: z.record(z.string(), z.number()),
});

export type UsageBucket = z.infer<typeof bucketSchema>;
export type AgentUsageBucket = z.infer<typeof agentBucketSchema>;
export type WorkspaceUsage = z.infer<typeof workspaceUsageSchema>;
export type AgentUsage = z.infer<typeof agentUsageSchema>;
export type RuntimeUsage = z.infer<typeof runtimeUsageSchema>;
export type IssueUsage = z.infer<typeof issueUsageSchema>;
export type DashboardOverview = z.infer<typeof dashboardSchema>;

export const USAGE_DAY_OPTIONS = [7, 30, 90] as const;

function base(workspaceId: string): string {
   return `/api/v1/usage/${encodeURIComponent(workspaceId)}`;
}

async function read<T>(path: string, schema: z.ZodType<T>): Promise<T> {
   const json: unknown = await apiFetch(path);
   const parsed = schema.safeParse(json);
   if (!parsed.success) throw new Error('Usage response was not recognized');
   return parsed.data;
}

export function getWorkspaceUsage(workspaceId: string, days: number): Promise<WorkspaceUsage> {
   return read(`${base(workspaceId)}/summary?days=${days}`, workspaceUsageSchema);
}

export function getAgentUsage(
   workspaceId: string,
   agentId: string,
   days: number
): Promise<AgentUsage> {
   return read(
      `${base(workspaceId)}/agents/${encodeURIComponent(agentId)}?days=${days}`,
      agentUsageSchema
   );
}

export function getRuntimeUsage(
   workspaceId: string,
   runtimeId: string,
   days: number
): Promise<RuntimeUsage> {
   return read(
      `${base(workspaceId)}/runtimes/${encodeURIComponent(runtimeId)}?days=${days}`,
      runtimeUsageSchema
   );
}

export function getIssueUsage(workspaceId: string, issueId: string): Promise<IssueUsage> {
   return read(`${base(workspaceId)}/issues/${encodeURIComponent(issueId)}`, issueUsageSchema);
}

export function getDashboard(workspaceId: string, days: number): Promise<DashboardOverview> {
   return read(
      `/api/v1/dashboard/${encodeURIComponent(workspaceId)}/overview?days=${days}`,
      dashboardSchema
   );
}

/** Micros to dollars, with more places for small amounts so a cheap run is not "$0.00". */
export function formatCost(micros: number): string {
   const dollars = micros / 1_000_000;
   if (micros === 0) return '$0';
   return `$${dollars.toFixed(dollars < 1 ? 4 : 2)}`;
}

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

export function formatTokens(count: number): string {
   return compact.format(count);
}

export function totalTokens(bucket: UsageBucket): number {
   return (
      bucket.inputTokens + bucket.outputTokens + bucket.cacheReadTokens + bucket.cacheWriteTokens
   );
}
