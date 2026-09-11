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
 *
 * Days are cut in the window's timezone, not always in UTC: a workspace that
 * works in Tokyo should not see its evening counted as tomorrow. A project
 * filter is the one thing the rollup cannot answer — it keeps no board — so a
 * filtered read falls back to the raw rows, shaped to look the same.
 */

export interface UsageWindow {
   days: number;
   from: string;
   to: string;
   /** IANA zone the daily and hourly buckets are cut in. */
   timezone: string;
}

/**
 * The offset of a zone at an instant, in milliseconds: what has to be added to
 * UTC to read the local wall clock.
 */
function zoneOffsetMs(at: Date, timeZone: string): number {
   const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
   }).formatToParts(at);
   const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? '0');
   // `hour` formats midnight as 24 in some locales' hour-cycle handling.
   const hour = read('hour') % 24;
   const asIfUtc = Date.UTC(read('year'), read('month') - 1, read('day'), hour, read('minute'), read('second'));
   return asIfUtc - at.getTime();
}

/** Whole local days: today plus the `days - 1` before it, cut in `timezone`. */
export function usageWindow(days: number, now: Date = new Date(), timezone = 'UTC'): UsageWindow {
   const offset = zoneOffsetMs(now, timezone);
   const local = new Date(now.getTime() + offset);
   const localMidnight = Date.UTC(
      local.getUTCFullYear(),
      local.getUTCMonth(),
      local.getUTCDate() - (days - 1)
   );
   // Two passes: the second uses the offset in force at the start of the
   // window rather than now, so a window spanning a DST change still begins
   // at local midnight.
   const approximate = localMidnight - offset;
   const start = new Date(localMidnight - zoneOffsetMs(new Date(approximate), timezone));
   return { days, from: start.toISOString(), to: now.toISOString(), timezone };
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

/** What the run ledger adds to a window: how many, and how long they took. */
export interface RunTotals {
   runs: number;
   failed: number;
   /** Wall-clock seconds of finished runs. A run still going adds nothing yet. */
   runSeconds: number;
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

/** What narrows a usage read beyond the workspace. */
export interface UsageFilter {
   agentId?: string | undefined;
   /** `{ id: null }` is the workspace-default runtime. Absent means every runtime. */
   runtime?: { id: string | null } | undefined;
   /** One project (board). Only the raw rows know it, so it changes the source. */
   boardId?: string | undefined;
}

function sums(q: ScopedQuery) {
   return q.sql`
      COALESCE(SUM(h.events), 0)::bigint AS events,
      COALESCE(SUM(h.unpriced_events), 0)::bigint AS unpriced_events,
      COALESCE(SUM(h.input_tokens), 0)::bigint AS input_tokens,
      COALESCE(SUM(h.output_tokens), 0)::bigint AS output_tokens,
      COALESCE(SUM(h.cache_read_tokens), 0)::bigint AS cache_read_tokens,
      COALESCE(SUM(h.cache_write_tokens), 0)::bigint AS cache_write_tokens,
      COALESCE(SUM(h.cost_micros), 0)::bigint AS cost_micros`;
}

/**
 * Where a usage read gets its rows.
 *
 * Without a project filter it is the hourly rollup, which is what it is for.
 * With one it is `task_usage`, shaped into the same columns — one row is one
 * report, so `events` is 1 and an unpriced report is 1 — because only the raw
 * row names the task, and only the task names the board.
 */
function usageSource(q: ScopedQuery, filter: UsageFilter) {
   if (filter.boardId === undefined) return q.sql`task_usage_hourly`;
   return q.sql`(
      SELECT u.workspace_id, u.occurred_at AS bucket, u.agent_id, u.runtime_id, u.model,
             1 AS events,
             CASE WHEN u.cost_micros IS NULL THEN 1 ELSE 0 END AS unpriced_events,
             u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_write_tokens,
             COALESCE(u.cost_micros, 0) AS cost_micros
        FROM task_usage AS u
        JOIN issues AS i ON i.id = u.issue_id
       WHERE i.board_id = ${filter.boardId}
   )`;
}

function narrow(q: ScopedQuery, filter: UsageFilter) {
   const agent = filter.agentId ? q.sql`AND h.agent_id = ${filter.agentId}` : q.sql``;
   const runtime =
      filter.runtime === undefined
         ? q.sql``
         : filter.runtime.id === null
           ? q.sql`AND h.runtime_id IS NULL`
           : q.sql`AND h.runtime_id = ${filter.runtime.id}`;
   return q.sql`${agent} ${runtime}`;
}

/** The window's local days, as timestamps in the window's zone. */
function localDays(q: ScopedQuery, window: UsageWindow) {
   return q.sql`generate_series(
      date_trunc('day', ${window.from}::timestamptz AT TIME ZONE ${window.timezone}),
      date_trunc('day', ${window.to}::timestamptz AT TIME ZONE ${window.timezone}),
      interval '1 day')`;
}

async function usageTotals(q: ScopedQuery, window: UsageWindow, filter: UsageFilter) {
   const [row] = await q.sql`
      SELECT 'total' AS key, ${sums(q)}
        FROM ${usageSource(q, filter)} AS h
       WHERE h.workspace_id = ${q.workspaceId} AND h.bucket >= ${window.from}
             ${narrow(q, filter)}`;
   return toBucket(row);
}

async function usageDaily(q: ScopedQuery, window: UsageWindow, filter: UsageFilter) {
   const rows = await q.sql`
      SELECT to_char(d.day, 'YYYY-MM-DD') AS key, ${sums(q)}
        FROM ${localDays(q, window)} AS d(day)
        LEFT JOIN ${usageSource(q, filter)} AS h
          ON h.workspace_id = ${q.workspaceId}
         AND h.bucket >= d.day AT TIME ZONE ${window.timezone}
         AND h.bucket < (d.day + interval '1 day') AT TIME ZONE ${window.timezone}
             ${narrow(q, filter)}
       GROUP BY d.day
       ORDER BY d.day`;
   return rows.map((row) => toBucket(row));
}

async function usageByAgent(q: ScopedQuery, window: UsageWindow, filter: UsageFilter) {
   const rows = await q.sql`
      SELECT h.agent_id::text AS key, COALESCE(a.name, 'Removed agent') AS agent_name,
             ${sums(q)}
        FROM ${usageSource(q, filter)} AS h
        LEFT JOIN agents AS a ON a.id = h.agent_id
       WHERE h.workspace_id = ${q.workspaceId} AND h.bucket >= ${window.from}
             ${narrow(q, filter)}
       GROUP BY h.agent_id, a.name
       ORDER BY cost_micros DESC, input_tokens DESC
       LIMIT 50`;
   return rows.map(toAgentBucket);
}

async function usageByModel(q: ScopedQuery, window: UsageWindow, filter: UsageFilter) {
   const rows = await q.sql`
      SELECT h.model AS key, ${sums(q)}
        FROM ${usageSource(q, filter)} AS h
       WHERE h.workspace_id = ${q.workspaceId} AND h.bucket >= ${window.from}
             ${narrow(q, filter)}
       GROUP BY h.model
       ORDER BY cost_micros DESC, input_tokens DESC
       LIMIT 50`;
   return rows.map((row) => toBucket(row));
}

async function usageByHour(q: ScopedQuery, window: UsageWindow, filter: UsageFilter) {
   const rows = await q.sql`
      SELECT to_char(g.hour, 'FM00') AS key, ${sums(q)}
        FROM generate_series(0, 23) AS g(hour)
        LEFT JOIN ${usageSource(q, filter)} AS h
          ON h.workspace_id = ${q.workspaceId}
         AND h.bucket >= ${window.from}
         AND EXTRACT(HOUR FROM h.bucket AT TIME ZONE ${window.timezone}) = g.hour
             ${narrow(q, filter)}
       GROUP BY g.hour
       ORDER BY g.hour`;
   return rows.map((row) => toBucket(row));
}

/** One row per day and model, for the runtime's day-by-model table. */
export interface DayModelRow {
   day: string;
   model: string;
   tokens: number;
   costMicros: number;
   unpricedEvents: number;
}

async function usageByDayModel(
   q: ScopedQuery,
   window: UsageWindow,
   filter: UsageFilter
): Promise<DayModelRow[]> {
   const rows = await q.sql`
      SELECT to_char(h.bucket AT TIME ZONE ${window.timezone}, 'YYYY-MM-DD') AS day,
             h.model AS model,
             COALESCE(SUM(h.input_tokens + h.output_tokens + h.cache_read_tokens
                          + h.cache_write_tokens), 0)::bigint AS tokens,
             COALESCE(SUM(h.cost_micros), 0)::bigint AS cost_micros,
             COALESCE(SUM(h.unpriced_events), 0)::bigint AS unpriced_events
        FROM ${usageSource(q, filter)} AS h
       WHERE h.workspace_id = ${q.workspaceId} AND h.bucket >= ${window.from}
             ${narrow(q, filter)}
       GROUP BY 1, 2
       ORDER BY 1 DESC, cost_micros DESC
       LIMIT 500`;
   return rows.map((row) => ({
      day: String(row.day),
      model: String(row.model),
      tokens: Number(row.tokens),
      costMicros: Number(row.cost_micros),
      unpricedEvents: Number(row.unpriced_events),
   }));
}

/** Runs scoped to the workspace, and to one project when the read asks for one. */
function runsInScope(q: ScopedQuery, filter: UsageFilter) {
   const board = filter.boardId ? q.sql`AND r.board_id = ${filter.boardId}` : q.sql``;
   const agent = filter.agentId ? q.sql`AND r.agent_id = ${filter.agentId}` : q.sql``;
   const runtime =
      filter.runtime === undefined
         ? q.sql``
         : filter.runtime.id === null
           ? q.sql`AND r.runtime_id IS NULL`
           : q.sql`AND r.runtime_id = ${filter.runtime.id}`;
   return q.sql`
      SELECT r.id, r.agent_id, r.issue_id, r.status, r.failure_code, r.created_at,
             r.started_at, r.completed_at
        FROM runs AS r
       WHERE r.workspace_id = ${q.workspaceId} ${board} ${agent} ${runtime}`;
}

async function runTotals(
   q: ScopedQuery,
   window: UsageWindow,
   filter: UsageFilter
): Promise<RunTotals> {
   const [row] = await q.sql`
      SELECT COUNT(*)::bigint AS runs,
             COUNT(*) FILTER (WHERE r.status = 'failed')::bigint AS failed,
             COALESCE(SUM(EXTRACT(EPOCH FROM (r.completed_at - r.started_at)))
                      FILTER (WHERE r.completed_at IS NOT NULL AND r.started_at IS NOT NULL), 0) AS seconds
        FROM (${runsInScope(q, filter)}) AS r
       WHERE r.created_at >= ${window.from}`;
   return {
      runs: Number(row?.runs ?? 0),
      failed: Number(row?.failed ?? 0),
      runSeconds: Math.round(Number(row?.seconds ?? 0)),
   };
}

export async function workspaceUsage(q: ScopedQuery, window: UsageWindow, filter: UsageFilter = {}) {
   const [totals, daily, byAgent, byModel, runs] = await Promise.all([
      usageTotals(q, window, filter),
      usageDaily(q, window, filter),
      usageByAgent(q, window, filter),
      usageByModel(q, window, filter),
      runTotals(q, window, filter),
   ]);
   return { totals, daily, byAgent, byModel, runs };
}

export async function agentUsage(q: ScopedQuery, agentId: string, window: UsageWindow) {
   const filter: UsageFilter = { agentId };
   const [totals, daily, byModel, runs] = await Promise.all([
      usageTotals(q, window, filter),
      usageDaily(q, window, filter),
      usageByModel(q, window, filter),
      runTotals(q, window, filter),
   ]);
   return { totals, daily, byModel, runs };
}

export async function runtimeUsage(q: ScopedQuery, runtimeId: string | null, window: UsageWindow) {
   const filter: UsageFilter = { runtime: { id: runtimeId } };
   const [totals, daily, byAgent, byHour, byModel, byDayModel, runs] = await Promise.all([
      usageTotals(q, window, filter),
      usageDaily(q, window, filter),
      usageByAgent(q, window, filter),
      usageByHour(q, window, filter),
      usageByModel(q, window, filter),
      usageByDayModel(q, window, filter),
      runTotals(q, window, filter),
   ]);
   return { totals, daily, byAgent, byHour, byModel, byDayModel, runs };
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

/** The project filter names a board; a board of another workspace is not one. */
export async function boardInWorkspace(q: ScopedQuery, boardId: string): Promise<boolean> {
   const rows = await q.sql`
      SELECT 1 FROM boards AS b WHERE b.id = ${boardId} AND b.workspace_id = ${q.workspaceId}`;
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

export interface ErrorsOverview {
   failedRuns: number;
   totalRuns: number;
   agentsAffected: number;
   daily: Array<{ day: string; total: number; failed: number }>;
   byType: Array<{ code: string; count: number }>;
   /** Ranked by failures; `total` is the sample each rate is computed from. */
   offenders: Array<{ agentId: string; agentName: string; failed: number; total: number }>;
}

/**
 * The errors tab: how much of the window failed, when, of what, and whose.
 *
 * The rate is deliberately not computed here. An agent that failed one of one
 * run is not "100% failing", and only a reader who can see the sample size can
 * judge that — so both numbers travel together.
 */
export async function errorsOverview(
   q: ScopedQuery,
   window: UsageWindow,
   filter: UsageFilter = {}
): Promise<ErrorsOverview> {
   const scope = runsInScope(q, filter);
   const [totals, daily, byType, offenders] = await Promise.all([
      q.sql`
         SELECT COUNT(*)::bigint AS total,
                COUNT(*) FILTER (WHERE r.status = 'failed')::bigint AS failed,
                COUNT(DISTINCT r.agent_id) FILTER (WHERE r.status = 'failed')::bigint AS agents
           FROM (${scope}) AS r
          WHERE r.created_at >= ${window.from}`,
      q.sql`
         SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
                COUNT(r.id)::bigint AS total,
                COUNT(r.id) FILTER (WHERE r.status = 'failed')::bigint AS failed
           FROM ${localDays(q, window)} AS d(day)
           LEFT JOIN (${scope}) AS r
             ON r.created_at >= d.day AT TIME ZONE ${window.timezone}
            AND r.created_at < (d.day + interval '1 day') AT TIME ZONE ${window.timezone}
          GROUP BY d.day
          ORDER BY d.day`,
      q.sql`
         SELECT COALESCE(r.failure_code, 'UNKNOWN') AS code, COUNT(*)::bigint AS count
           FROM (${scope}) AS r
          WHERE r.status = 'failed' AND r.created_at >= ${window.from}
          GROUP BY 1
          ORDER BY count DESC, code ASC
          LIMIT 20`,
      q.sql`
         SELECT r.agent_id::text AS agent_id, COALESCE(a.name, 'Removed agent') AS agent_name,
                COUNT(*) FILTER (WHERE r.status = 'failed')::bigint AS failed,
                COUNT(*)::bigint AS total
           FROM (${scope}) AS r
           LEFT JOIN agents AS a ON a.id = r.agent_id
          WHERE r.created_at >= ${window.from}
          GROUP BY r.agent_id, a.name
         HAVING COUNT(*) FILTER (WHERE r.status = 'failed') > 0
          ORDER BY failed DESC, total DESC
          LIMIT 20`,
   ]);
   const head = totals[0];
   return {
      failedRuns: Number(head?.failed ?? 0),
      totalRuns: Number(head?.total ?? 0),
      agentsAffected: Number(head?.agents ?? 0),
      daily: daily.map((row) => ({
         day: String(row.day),
         total: Number(row.total),
         failed: Number(row.failed),
      })),
      byType: byType.map((row) => ({ code: String(row.code), count: Number(row.count) })),
      offenders: offenders.map((row) => ({
         agentId: String(row.agent_id),
         agentName: String(row.agent_name),
         failed: Number(row.failed),
         total: Number(row.total),
      })),
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
 * The workspace at a glance. Runs are scoped through their board, the way the
 * board-bound ledger reads them; the task snapshot is every live task now, not
 * only the window's.
 */
export async function dashboardOverview(q: ScopedQuery, window: UsageWindow): Promise<DashboardOverview> {
   const boardRuns = q.sql`
      SELECT r.id, r.agent_id, r.issue_id, r.status, r.created_at, r.started_at
        FROM runs AS r
        JOIN boards AS b ON b.id = r.board_id
       WHERE b.workspace_id = ${q.workspaceId}`;

   const [spendDaily, runsDaily, failures, counts, working, tasks] = await Promise.all([
      usageDaily(q, window, {}),
      q.sql`
         SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
                COUNT(r.id)::bigint AS total,
                COUNT(r.id) FILTER (WHERE r.status = 'succeeded')::bigint AS succeeded,
                COUNT(r.id) FILTER (WHERE r.status = 'failed')::bigint AS failed,
                COUNT(r.id) FILTER (WHERE r.status = 'cancelled')::bigint AS cancelled
           FROM ${localDays(q, window)} AS d(day)
           LEFT JOIN (${boardRuns}) AS r
             ON r.created_at >= d.day AT TIME ZONE ${window.timezone}
            AND r.created_at < (d.day + interval '1 day') AT TIME ZONE ${window.timezone}
          GROUP BY d.day
          ORDER BY d.day`,
      q.sql`
         SELECT r.agent_id::text AS agent_id, COALESCE(a.name, 'Removed agent') AS agent_name,
                COUNT(*) FILTER (WHERE r.status = 'failed')::bigint AS failed,
                COUNT(*)::bigint AS total
           FROM (${boardRuns}) AS r
           LEFT JOIN agents AS a ON a.id = r.agent_id
          WHERE r.created_at >= ${window.from}
          GROUP BY r.agent_id, a.name
         HAVING COUNT(*) FILTER (WHERE r.status = 'failed') > 0
          ORDER BY failed DESC, total DESC
          LIMIT 20`,
      q.sql`
         SELECT r.status::text AS status, COUNT(*)::bigint AS count
           FROM (${boardRuns}) AS r
          WHERE r.created_at >= ${window.from} OR r.status IN ('queued', 'running')
          GROUP BY r.status`,
      q.sql`
         SELECT r.id AS run_id, r.agent_id::text AS agent_id,
                COALESCE(a.name, 'Removed agent') AS agent_name,
                r.issue_id::text AS issue_id, i.title AS issue_title, r.started_at
           FROM (${boardRuns}) AS r
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
      usageDaily: spendDaily,
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
