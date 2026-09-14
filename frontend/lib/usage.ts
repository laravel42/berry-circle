import { z } from 'zod';
import { apiFetch } from './api';

/**
 * Usage and dashboard reads. Money arrives as integer USD micros and tokens as
 * integers; formatting happens here, once, so every panel says the same thing.
 *
 * Every windowed read takes the same three questions: how far back, whose days
 * (the bucketing zone), and which project. The answers travel back in the
 * response, so a panel can say what it is actually showing rather than what it
 * asked for.
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

/** What the run ledger adds: how many runs, and how long they took. */
const runTotalsSchema = z.object({
   runs: z.number(),
   failed: z.number(),
   runSeconds: z.number(),
});

const windowSchema = z.object({
   currency: z.literal('USD'),
   days: z.number(),
   from: z.string(),
   to: z.string(),
   timezone: z.string().default('UTC'),
   boardId: z.string().nullable().default(null),
});

const workspaceUsageSchema = windowSchema.extend({
   totals: bucketSchema,
   daily: z.array(bucketSchema),
   byAgent: z.array(agentBucketSchema),
   byModel: z.array(bucketSchema),
   runs: runTotalsSchema,
});

const agentUsageSchema = windowSchema.extend({
   totals: bucketSchema,
   daily: z.array(bucketSchema),
   byModel: z.array(bucketSchema),
   runs: runTotalsSchema,
});

const dayModelSchema = z.object({
   day: z.string(),
   model: z.string(),
   tokens: z.number(),
   costMicros: z.number(),
   unpricedEvents: z.number(),
});

const runtimeUsageSchema = windowSchema.extend({
   totals: bucketSchema,
   daily: z.array(bucketSchema),
   byAgent: z.array(agentBucketSchema),
   byHour: z.array(bucketSchema),
   byModel: z.array(bucketSchema),
   byDayModel: z.array(dayModelSchema),
   runs: runTotalsSchema,
});

const issueUsageSchema = z.object({
   currency: z.literal('USD'),
   totals: bucketSchema,
   byRun: z.array(bucketSchema),
   byModel: z.array(bucketSchema),
});

const errorsSchema = windowSchema.extend({
   failedRuns: z.number(),
   totalRuns: z.number(),
   agentsAffected: z.number(),
   daily: z.array(z.object({ day: z.string(), total: z.number(), failed: z.number() })),
   byType: z.array(z.object({ code: z.string(), count: z.number() })),
   offenders: z.array(
      z.object({
         agentId: z.string(),
         agentName: z.string(),
         failed: z.number(),
         total: z.number(),
      })
   ),
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
export type RunTotals = z.infer<typeof runTotalsSchema>;
export type DayModelRow = z.infer<typeof dayModelSchema>;
export type WorkspaceUsage = z.infer<typeof workspaceUsageSchema>;
export type AgentUsage = z.infer<typeof agentUsageSchema>;
export type RuntimeUsage = z.infer<typeof runtimeUsageSchema>;
export type IssueUsage = z.infer<typeof issueUsageSchema>;
export type UsageErrors = z.infer<typeof errorsSchema>;
export type DashboardOverview = z.infer<typeof dashboardSchema>;

export const USAGE_DAY_OPTIONS = [7, 30, 90] as const;
/** A runtime's own page reaches back further: the heatmap wants 26 weeks. */
export const RUNTIME_DAY_OPTIONS = [7, 30, 90, 180] as const;

/** How far back, in whose days, and on which project. */
export interface UsageQuery {
   days: number;
   timezone?: string | undefined;
   boardId?: string | null | undefined;
}

function base(workspaceId: string): string {
   return `/api/v1/usage/${encodeURIComponent(workspaceId)}`;
}

function search(query: UsageQuery): string {
   const params = new URLSearchParams({ days: String(query.days) });
   if (query.timezone) params.set('tz', query.timezone);
   if (query.boardId) params.set('boardId', query.boardId);
   return `?${params.toString()}`;
}

async function read<T>(path: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T> {
   const json: unknown = await apiFetch(path);
   const parsed = schema.safeParse(json);
   if (!parsed.success) throw new Error('Usage response was not recognized');
   return parsed.data;
}

export function getWorkspaceUsage(workspaceId: string, query: UsageQuery): Promise<WorkspaceUsage> {
   return read(`${base(workspaceId)}/summary${search(query)}`, workspaceUsageSchema);
}

export function getUsageErrors(workspaceId: string, query: UsageQuery): Promise<UsageErrors> {
   return read(`${base(workspaceId)}/errors${search(query)}`, errorsSchema);
}

export function getAgentUsage(
   workspaceId: string,
   agentId: string,
   query: UsageQuery
): Promise<AgentUsage> {
   return read(
      `${base(workspaceId)}/agents/${encodeURIComponent(agentId)}${search(query)}`,
      agentUsageSchema
   );
}

export function getRuntimeUsage(
   workspaceId: string,
   runtimeId: string,
   query: UsageQuery
): Promise<RuntimeUsage> {
   return read(
      `${base(workspaceId)}/runtimes/${encodeURIComponent(runtimeId)}${search(query)}`,
      runtimeUsageSchema
   );
}

export function getIssueUsage(workspaceId: string, issueId: string): Promise<IssueUsage> {
   return read(`${base(workspaceId)}/issues/${encodeURIComponent(issueId)}`, issueUsageSchema);
}

export function getDashboard(workspaceId: string, query: UsageQuery): Promise<DashboardOverview> {
   return read(
      `/api/v1/dashboard/${encodeURIComponent(workspaceId)}/overview${search(query)}`,
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

/** Run time as a person reads it: "3 h 12 m", "45 m", "30 s". */
export function formatDuration(seconds: number): string {
   if (seconds <= 0) return '0 s';
   const hours = Math.floor(seconds / 3600);
   const minutes = Math.round((seconds % 3600) / 60);
   if (hours > 0) return `${hours} h ${minutes} m`;
   if (seconds >= 60) return `${Math.round(seconds / 60)} m`;
   return `${Math.round(seconds)} s`;
}

export function totalTokens(bucket: UsageBucket): number {
   return (
      bucket.inputTokens + bucket.outputTokens + bucket.cacheReadTokens + bucket.cacheWriteTokens
   );
}

function emptyBucket(key: string): UsageBucket {
   return {
      key,
      events: 0,
      unpricedEvents: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costMicros: 0,
   };
}

/**
 * Daily buckets folded into weeks of seven, newest week last.
 *
 * The server answers days because that is what it stores; a long window read
 * day by day is unreadable, so the chart offers weeks. The first group may be
 * short — a window rarely starts on a week boundary — and is left short rather
 * than padded, because a half week that claims to be whole reads as a dip.
 */
export function weeklyBuckets(daily: UsageBucket[]): UsageBucket[] {
   const weeks: UsageBucket[] = [];
   const leading = daily.length % 7;
   let index = 0;
   while (index < daily.length) {
      const size = weeks.length === 0 && leading > 0 ? leading : 7;
      const slice = daily.slice(index, index + size);
      const first = slice[0];
      if (!first) break;
      const week = slice.reduce(
         (sum, day) => ({
            key: sum.key,
            events: sum.events + day.events,
            unpricedEvents: sum.unpricedEvents + day.unpricedEvents,
            inputTokens: sum.inputTokens + day.inputTokens,
            outputTokens: sum.outputTokens + day.outputTokens,
            cacheReadTokens: sum.cacheReadTokens + day.cacheReadTokens,
            cacheWriteTokens: sum.cacheWriteTokens + day.cacheWriteTokens,
            costMicros: sum.costMicros + day.costMicros,
         }),
         emptyBucket(first.key)
      );
      weeks.push(week);
      index += size;
   }
   return weeks;
}
