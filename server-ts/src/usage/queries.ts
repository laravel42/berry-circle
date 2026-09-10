import type { ScopedQuery } from '../identity/workspace-context.ts';
import { issueStatusToApi } from '../runs/ledger.ts';

/**
 * Every read behind the Usage page, the Dashboard and the usage panels.
 *
 * Each takes a {@link ScopedQuery}, and each predicate is on
 * `q.workspaceId` — the membership-confirmed scope, never a request value —
 * so a foreign id finds nothing rather than someone else's spend. Charts read
 * the hourly rollup; a task's own panel reads the raw rows, because it wants
 * each run and there are few.
 */

export interface UsageWindow {
   days: number;
   from: string;
   to: string;
}

/** Whole UTC days: today plus the `days - 1` before it. */
export function usageWindow(days: number, now: Date = new Date()): UsageWindow {
   const start = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1))
   );
   return { days, from: start.toISOString(), to: now.toISOString() };
}

export interface UsageBucket {
   key: string;
   events: number;
   /** Reports with no published price; their tokens count, their cost does not. */
   unpricedEvents: number;
   inputTokens: number;
   outputTokens: number;
   cacheReadTokens: number;
   cacheWriteTokens: number;
   costMicros: number;
}

export interface AgentUsageBucket extends UsageBucket {
   agentName: string;
}

type Row = Record<string, unknown>;

function toBucket(row: Row | undefined, fallbackKey = 'total'): UsageBucket {
   return {
      key: row?.key === undefined || row.key === null ? fallbackKey : String(row.key),
      events: Number(row?.events ?? 0),
      unpricedEvents: Number(row?.unpriced_events ?? 0),
      inputTokens: Number(row?.input_tokens ?? 0),
      outputTokens: Number(row?.output_tokens ?? 0),
      cacheReadTokens: Number(row?.cache_read_tokens ?? 0),
      cacheWriteTokens: Number(row?.cache_write_tokens ?? 0),
      costMicros: Number(row?.cost_micros ?? 0),
   };
}

function toAgentBucket(row: Row): AgentUsageBucket {
   return { ...toBucket(row), agentName: String(row.agent_name) };
}

/** What narrows the hourly rollup beyond the workspace. */
interface HourlyFilter {
   agentId?: string;
   /** `{ id: null }` is the workspace-default runtime. Absent means every runtime. */
   runtime?: { id: string | null };
}

function hourlySums(q: ScopedQuery) {
   return q.sql`
      COALESCE(SUM(h.events), 0)::bigint AS events,
      COALESCE(SUM(h.unpriced_events), 0)::bigint AS unpriced_events,
      COALESCE(SUM(h.input_tokens), 0)::bigint AS input_tokens,
      COALESCE(SUM(h.output_tokens), 0)::bigint AS output_tokens,
      COALESCE(SUM(h.cache_read_tokens), 0)::bigint AS cache_read_tokens,
      COALESCE(SUM(h.cache_write_tokens), 0)::bigint AS cache_write_tokens,
      COALESCE(SUM(h.cost_micros), 0)::bigint AS cost_micros`;
}

function hourlyFilter(q: ScopedQuery, filter: HourlyFilter) {
   const agent = filter.agentId ? q.sql`AND h.agent_id = ${filter.agentId}` : q.sql``;
   const runtime =
      filter.runtime === undefined
         ? q.sql``
         : filter.runtime.id === null
           ? q.sql`AND h.runtime_id IS NULL`
           : q.sql`AND h.runtime_id = ${filter.runtime.id}`;
   return q.sql`${agent} ${runtime}`;
}

async function hourlyTotals(q: ScopedQuery, window: UsageWindow, filter: HourlyFilter) {
   const [row] = await q.sql`
      SELECT 'total' AS key, ${hourlySums(q)}
        FROM task_usage_hourly AS h
       WHERE h.workspace_id = ${q.workspaceId} AND h.bucket >= ${window.from}
             ${hourlyFilter(q, filter)}`;
   return toBucket(row);
}

async function hourlyDaily(q: ScopedQuery, window: UsageWindow, filter: HourlyFilter) {
   const rows = await q.sql`
      SELECT to_char(d.day AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS key, ${hourlySums(q)}
        FROM generate_series(${window.from}::timestamptz, ${window.to}::timestamptz,
                             interval '1 day') AS d(day)
        LEFT JOIN task_usage_hourly AS h
          ON h.workspace_id = ${q.workspaceId}
         AND h.bucket >= d.day AND h.bucket < d.day + interval '1 day'
             ${hourlyFilter(q, filter)}
       GROUP BY d.day
       ORDER BY d.day`;
   return rows.map((row) => toBucket(row));
}

async function hourlyByAgent(q: ScopedQuery, window: UsageWindow, filter: HourlyFilter) {
   const rows = await q.sql`
      SELECT h.agent_id::text AS key, COALESCE(a.name, 'Removed agent') AS agent_name,
             ${hourlySums(q)}
        FROM task_usage_hourly AS h
        LEFT JOIN agents AS a ON a.id = h.agent_id
       WHERE h.workspace_id = ${q.workspaceId} AND h.bucket >= ${window.from}
             ${hourlyFilter(q, filter)}
       GROUP BY h.agent_id, a.name
       ORDER BY cost_micros DESC, input_tokens DESC
       LIMIT 50`;
   return rows.map(toAgentBucket);
}

async function hourlyByModel(q: ScopedQuery, window: UsageWindow, filter: HourlyFilter) {
   const rows = await q.sql`
      SELECT h.model AS key, ${hourlySums(q)}
        FROM task_usage_hourly AS h
       WHERE h.workspace_id = ${q.workspaceId} AND h.bucket >= ${window.from}
             ${hourlyFilter(q, filter)}
       GROUP BY h.model
       ORDER BY cost_micros DESC, input_tokens DESC
       LIMIT 50`;
   return rows.map((row) => toBucket(row));
}

async function hourlyByHour(q: ScopedQuery, window: UsageWindow, filter: HourlyFilter) {
   const rows = await q.sql`
      SELECT to_char(g.hour, 'FM00') AS key, ${hourlySums(q)}
        FROM generate_series(0, 23) AS g(hour)
        LEFT JOIN task_usage_hourly AS h
          ON h.workspace_id = ${q.workspaceId}
         AND h.bucket >= ${window.from}
         AND EXTRACT(HOUR FROM h.bucket AT TIME ZONE 'UTC') = g.hour
             ${hourlyFilter(q, filter)}
       GROUP BY g.hour
       ORDER BY g.hour`;
   return rows.map((row) => toBucket(row));
}

export async function workspaceUsage(q: ScopedQuery, window: UsageWindow) {
   const filter: HourlyFilter = {};
   const [totals, daily, byAgent, byModel] = await Promise.all([
      hourlyTotals(q, window, filter),
      hourlyDaily(q, window, filter),
      hourlyByAgent(q, window, filter),
      hourlyByModel(q, window, filter),
   ]);
   return { totals, daily, byAgent, byModel };
}

export async function agentUsage(q: ScopedQuery, agentId: string, window: UsageWindow) {
   const filter: HourlyFilter = { agentId };
   const [totals, daily, byModel] = await Promise.all([
      hourlyTotals(q, window, filter),
      hourlyDaily(q, window, filter),
      hourlyByModel(q, window, filter),
   ]);
   return { totals, daily, byModel };
}

export async function runtimeUsage(q: ScopedQuery, runtimeId: string | null, window: UsageWindow) {
   const filter: HourlyFilter = { runtime: { id: runtimeId } };
   const [totals, daily, byAgent, byHour] = await Promise.all([
      hourlyTotals(q, window, filter),
      hourlyDaily(q, window, filter),
      hourlyByAgent(q, window, filter),
      hourlyByHour(q, window, filter),
   ]);
   return { totals, daily, byAgent, byHour };
}

/**
 * Whether a runtime id may be read from this workspace.
 *
 * `agent_runtimes` is workstream A's table and may not exist yet. Until it
 * does, only the workspace default (`'default'`, handled by the mount) is a
 * runtime. A platform runtime (no workspace) is visible to every workspace;
 * its usage is still filtered to this one.
 */
export async function runtimeVisible(q: ScopedQuery, runtimeId: string): Promise<boolean> {
   const [registry] = await q.sql`
      SELECT to_regclass('public.agent_runtimes') IS NOT NULL AS present`;
   if (!registry?.present) return false;
   const rows = await q.sql`
      SELECT 1 FROM agent_runtimes
       WHERE id = ${runtimeId}
         AND (workspace_id = ${q.workspaceId} OR workspace_id IS NULL)`;
   return rows.length > 0;
}

export async function issueInWorkspace(q: ScopedQuery, issueId: string): Promise<boolean> {
   const rows = await q.sql`
      SELECT 1 FROM issues AS i
        JOIN boards AS b ON b.id = i.board_id
       WHERE i.id = ${issueId} AND b.workspace_id = ${q.workspaceId} AND i.deleted_at IS NULL`;
   return rows.length > 0;
}

function rawSums(q: ScopedQuery) {
   return q.sql`
      COUNT(u.id)::bigint AS events,
      COUNT(u.id) FILTER (WHERE u.cost_micros IS NULL)::bigint AS unpriced_events,
      COALESCE(SUM(u.input_tokens), 0)::bigint AS input_tokens,
      COALESCE(SUM(u.output_tokens), 0)::bigint AS output_tokens,
      COALESCE(SUM(u.cache_read_tokens), 0)::bigint AS cache_read_tokens,
      COALESCE(SUM(u.cache_write_tokens), 0)::bigint AS cache_write_tokens,
      COALESCE(SUM(u.cost_micros), 0)::bigint AS cost_micros`;
}

export async function issueUsage(q: ScopedQuery, issueId: string) {
   const [totalsRow] = await q.sql`
      SELECT 'total' AS key, ${rawSums(q)}
        FROM task_usage AS u
       WHERE u.workspace_id = ${q.workspaceId} AND u.issue_id = ${issueId}`;
   const byRun = await q.sql`
      SELECT u.run_id::text AS key, ${rawSums(q)}
        FROM task_usage AS u
       WHERE u.workspace_id = ${q.workspaceId} AND u.issue_id = ${issueId}
       GROUP BY u.run_id
       ORDER BY MIN(u.occurred_at)`;
   const byModel = await q.sql`
      SELECT u.model AS key, ${rawSums(q)}
        FROM task_usage AS u
       WHERE u.workspace_id = ${q.workspaceId} AND u.issue_id = ${issueId}
       GROUP BY u.model
       ORDER BY cost_micros DESC`;
   return {
      totals: toBucket(totalsRow),
      byRun: byRun.map((row) => toBucket(row)),
      byModel: byModel.map((row) => toBucket(row)),
   };
}

const RUN_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
type RunStatus = (typeof RUN_STATUSES)[number];

const TASK_STATUSES = ['backlog', 'todo', 'inProgress', 'inReview', 'blocked', 'done', 'cancelled'];

export interface DashboardOverview {
   usageDaily: UsageBucket[];
   runsDaily: Array<{ day: string; total: number; succeeded: number; failed: number; cancelled: number }>;
   failuresByAgent: Array<{ agentId: string; agentName: string; failed: number; total: number }>;
   runCounts: Record<RunStatus, number>;
   workingAgents: Array<{
      runId: string;
      agentId: string;
      agentName: string;
      issueId: string;
      issueTitle: string;
      startedAt: string | null;
   }>;
   taskSnapshot: Record<string, number>;
}

/**
 * The workspace at a glance. Runs have no workspace column, so they are
 * scoped through their board; the task snapshot is every live task now,
 * not only the window's.
 */
export async function dashboardOverview(q: ScopedQuery, window: UsageWindow): Promise<DashboardOverview> {
   const runsInScope = q.sql`
      SELECT r.id, r.agent_id, r.issue_id, r.status, r.created_at, r.started_at
        FROM runs AS r
        JOIN boards AS b ON b.id = r.board_id
       WHERE b.workspace_id = ${q.workspaceId}`;

   const [usageDaily, runsDaily, failures, counts, working, tasks] = await Promise.all([
      hourlyDaily(q, window, {}),
      q.sql`
         SELECT to_char(d.day AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
                COUNT(r.id)::bigint AS total,
                COUNT(r.id) FILTER (WHERE r.status = 'succeeded')::bigint AS succeeded,
                COUNT(r.id) FILTER (WHERE r.status = 'failed')::bigint AS failed,
                COUNT(r.id) FILTER (WHERE r.status = 'cancelled')::bigint AS cancelled
           FROM generate_series(${window.from}::timestamptz, ${window.to}::timestamptz,
                                interval '1 day') AS d(day)
           LEFT JOIN (${runsInScope}) AS r
             ON r.created_at >= d.day AND r.created_at < d.day + interval '1 day'
          GROUP BY d.day
          ORDER BY d.day`,
      q.sql`
         SELECT r.agent_id::text AS agent_id, COALESCE(a.name, 'Removed agent') AS agent_name,
                COUNT(*) FILTER (WHERE r.status = 'failed')::bigint AS failed,
                COUNT(*)::bigint AS total
           FROM (${runsInScope}) AS r
           LEFT JOIN agents AS a ON a.id = r.agent_id
          WHERE r.created_at >= ${window.from}
          GROUP BY r.agent_id, a.name
         HAVING COUNT(*) FILTER (WHERE r.status = 'failed') > 0
          ORDER BY failed DESC, total DESC
          LIMIT 20`,
      q.sql`
         SELECT r.status::text AS status, COUNT(*)::bigint AS count
           FROM (${runsInScope}) AS r
          WHERE r.created_at >= ${window.from} OR r.status IN ('queued', 'running')
          GROUP BY r.status`,
      q.sql`
         SELECT r.id AS run_id, r.agent_id::text AS agent_id,
                COALESCE(a.name, 'Removed agent') AS agent_name,
                r.issue_id::text AS issue_id, i.title AS issue_title, r.started_at
           FROM (${runsInScope}) AS r
           JOIN issues AS i ON i.id = r.issue_id
           LEFT JOIN agents AS a ON a.id = r.agent_id
          WHERE r.status = 'running'
          ORDER BY r.started_at NULLS LAST
          LIMIT 50`,
      q.sql`
         SELECT i.status::text AS status, COUNT(*)::bigint AS count
           FROM issues AS i
           JOIN boards AS b ON b.id = i.board_id
          WHERE b.workspace_id = ${q.workspaceId} AND i.deleted_at IS NULL
          GROUP BY i.status`,
   ]);

   const runCounts = Object.fromEntries(RUN_STATUSES.map((status) => [status, 0])) as Record<
      RunStatus,
      number
   >;
   for (const row of counts) {
      const status = String(row.status);
      if ((RUN_STATUSES as readonly string[]).includes(status)) {
         runCounts[status as RunStatus] = Number(row.count);
      }
   }

   const taskSnapshot: Record<string, number> = Object.fromEntries(
      TASK_STATUSES.map((status) => [status, 0])
   );
   for (const row of tasks) {
      const key = issueStatusToApi(String(row.status));
      taskSnapshot[key] = (taskSnapshot[key] ?? 0) + Number(row.count);
   }

   return {
      usageDaily,
      runsDaily: runsDaily.map((row) => ({
         day: String(row.day),
         total: Number(row.total),
         succeeded: Number(row.succeeded),
         failed: Number(row.failed),
         cancelled: Number(row.cancelled),
      })),
      failuresByAgent: failures.map((row) => ({
         agentId: String(row.agent_id),
         agentName: String(row.agent_name),
         failed: Number(row.failed),
         total: Number(row.total),
      })),
      runCounts,
      workingAgents: working.map((row) => ({
         runId: String(row.run_id),
         agentId: String(row.agent_id),
         agentName: String(row.agent_name),
         issueId: String(row.issue_id),
         issueTitle: String(row.issue_title),
         startedAt: row.started_at === null ? null : new Date(String(row.started_at)).toISOString(),
      })),
      taskSnapshot,
   };
}
