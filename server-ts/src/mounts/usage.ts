import { Hono } from 'hono';
import type { SessionService } from '../auth/sessions.ts';
import type { Sql } from '../db/pool.ts';
import { json } from '../http/app.ts';
import { assertValid, fieldError } from '../http/body.ts';
import { ApiError, type FieldError } from '../http/errors.ts';
import type { Mount } from '../http/registry.ts';
import { toApiError } from '../identity/errors.ts';
import type { ScopedDb, ScopedQuery } from '../identity/workspace-context.ts';
import {
   agentUsage,
   boardInWorkspace,
   dashboardOverview,
   errorsOverview,
   issueInWorkspace,
   issueUsage,
   runtimeUsage,
   runtimeVisible,
   usageWindow,
   workspaceUsage,
   type UsageWindow,
} from '../usage/queries.ts';
import { mountWorkspaceScope, pathId, type ScopedVariables } from './shared.ts';

/**
 * `/api/v1/usage` and `/api/v1/dashboard`.
 *
 * Read-only projections of `task_usage_hourly`, `task_usage`, `runs` and
 * `issues`. Both sit under `/:workspaceId/…`, so the workspace guard confirms
 * membership before a handler runs. Every nested id (agent, task, runtime,
 * project) is checked against that workspace too, so a foreign id is the same
 * 404 as an absent one.
 */

const DEFAULT_DAYS = 30;
/** Half a year. The runtime heatmap asks for 26 weeks, which is 182 days. */
const MAX_DAYS = 180;

export interface UsageMountOptions {
   sessions: SessionService;
   sql: Sql;
}

export function usageMounts(options: UsageMountOptions): Mount[] {
   return [
      { prefix: '/api/v1/usage', handler: usageRoute(options) },
      { prefix: '/api/v1/dashboard', handler: dashboardRoute(options) },
   ];
}

function usageRoute(options: UsageMountOptions): Hono<{ Variables: ScopedVariables }> {
   const route = new Hono<{ Variables: ScopedVariables }>();
   mountWorkspaceScope(route, options);

   route.get('/:workspaceId/summary', async (context) => {
      const db = context.get('scoped');
      const { window, boardId } = await readWindow(context.req.url, db);
      const body = await scopedRead(db, (q) =>
         workspaceUsage(q, window, boardId ? { boardId } : {})
      );
      return json({ ...windowFields(window, boardId), ...body });
   });

   route.get('/:workspaceId/errors', async (context) => {
      const db = context.get('scoped');
      const { window, boardId } = await readWindow(context.req.url, db);
      const body = await scopedRead(db, (q) =>
         errorsOverview(q, window, boardId ? { boardId } : {})
      );
      return json({ ...windowFields(window, boardId), ...body });
   });

   route.get('/:workspaceId/agents/:agentId', async (context) => {
      const db = context.get('scoped');
      const { window } = await readWindow(context.req.url, db);
      const agentId = pathId(context.req.param('agentId'), 'Agent');
      try {
         await db.requireResource('agents', agentId);
      } catch (error) {
         throw toApiError(error, 'Agent');
      }
      const body = await scopedRead(db, (q) => agentUsage(q, agentId, window));
      return json({ ...windowFields(window, null), ...body });
   });

   route.get('/:workspaceId/runtimes/:runtimeId', async (context) => {
      const db = context.get('scoped');
      const { window } = await readWindow(context.req.url, db);
      const raw = context.req.param('runtimeId');
      const runtimeId = raw === 'default' ? null : pathId(raw, 'Runtime');
      if (runtimeId !== null && !(await scopedRead(db, (q) => runtimeVisible(q, runtimeId)))) {
         throw ApiError.notFound('Runtime');
      }
      const body = await scopedRead(db, (q) => runtimeUsage(q, runtimeId, window));
      return json({ ...windowFields(window, null), ...body });
   });

   route.get('/:workspaceId/issues/:issueId', async (context) => {
      parseQuery(context.req.url, false);
      const issueId = pathId(context.req.param('issueId'), 'Issue');
      const db = context.get('scoped');
      if (!(await scopedRead(db, (q) => issueInWorkspace(q, issueId)))) {
         throw ApiError.notFound('Issue');
      }
      const body = await scopedRead(db, (q) => issueUsage(q, issueId));
      return json({ currency: 'USD', ...body });
   });

   return route;
}

function dashboardRoute(options: UsageMountOptions): Hono<{ Variables: ScopedVariables }> {
   const route = new Hono<{ Variables: ScopedVariables }>();
   mountWorkspaceScope(route, options);

   route.get('/:workspaceId/overview', async (context) => {
      const db = context.get('scoped');
      const { window } = await readWindow(context.req.url, db);
      const body = await scopedRead(db, (q) => dashboardOverview(q, window));
      return json({ ...windowFields(window, null), ...body });
   });

   return route;
}

function windowFields(window: UsageWindow, boardId: string | null) {
   return {
      currency: 'USD',
      days: window.days,
      from: window.from,
      to: window.to,
      timezone: window.timezone,
      boardId,
   };
}

/** A zone this deployment's ICU can actually cut days in. */
function knownTimezone(name: string): boolean {
   try {
      new Intl.DateTimeFormat('en-US', { timeZone: name });
      return true;
   } catch {
      return false;
   }
}

interface WindowQuery {
   days: number;
   timezone: string;
   boardId: string | null;
}

/**
 * The parameters of a windowed read: how far back, in whose days, and on which
 * project. An unrecognised parameter is a typo, and a read that ignored it
 * would answer a question nobody asked.
 */
function parseQuery(rawUrl: string, windowed: boolean): WindowQuery {
   const params = new URL(rawUrl).searchParams;
   const allowed = new Set(windowed ? ['days', 'tz', 'boardId'] : []);
   const errors: FieldError[] = [];
   for (const name of new Set(params.keys())) {
      if (!allowed.has(name)) {
         errors.push(fieldError(`/${name}`, 'unknown', `${name} is not a parameter of this read.`));
      }
   }

   let days = DEFAULT_DAYS;
   const rawDays = windowed ? params.get('days') : null;
   if (rawDays !== null) {
      const parsed = /^\d{1,3}$/.test(rawDays) ? Number(rawDays) : NaN;
      if (!(parsed >= 1 && parsed <= MAX_DAYS)) {
         errors.push(fieldError('/days', 'invalid_value', `days is a whole number from 1 to ${MAX_DAYS}.`));
      } else {
         days = parsed;
      }
   }

   let timezone = 'UTC';
   const rawZone = windowed ? params.get('tz') : null;
   if (rawZone !== null) {
      if (rawZone.length > 64 || !knownTimezone(rawZone)) {
         errors.push(fieldError('/tz', 'invalid_value', 'tz is an IANA time zone name, such as Europe/Rome.'));
      } else {
         timezone = rawZone;
      }
   }

   let boardId: string | null = null;
   const rawBoard = windowed ? params.get('boardId') : null;
   if (rawBoard !== null) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawBoard)) {
         errors.push(fieldError('/boardId', 'invalid_value', 'boardId names one project.'));
      } else {
         boardId = rawBoard.toLowerCase();
      }
   }

   assertValid(errors);
   return { days, timezone, boardId };
}

/**
 * The window a read asked for, with its project confirmed to be this
 * workspace's — a board from another one is the same 404 as one that is not
 * there, like every other id a route names.
 */
async function readWindow(
   rawUrl: string,
   db: ScopedDb
): Promise<{ window: UsageWindow; boardId: string | null }> {
   const query = parseQuery(rawUrl, true);
   if (query.boardId && !(await scopedRead(db, (q) => boardInWorkspace(q, query.boardId as string)))) {
      throw ApiError.notFound('Project');
   }
   return {
      window: usageWindow(query.days, new Date(), query.timezone),
      boardId: query.boardId,
   };
}

/** One scoped read that returns a value rather than rows. */
async function scopedRead<T>(db: ScopedDb, read: (q: ScopedQuery) => Promise<T>): Promise<T> {
   const [value] = await db.list(async (q) => [await read(q)]);
   if (value === undefined) throw new Error('a scoped read returned nothing');
   return value;
}
