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
   dashboardOverview,
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
 * membership before a handler runs. Every nested id (agent, task, runtime)
 * is checked against that workspace too, so a foreign id is the same 404 as
 * an absent one.
 */

const DEFAULT_DAYS = 30;
const MAX_DAYS = 90;

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
      const window = usageWindow(parseQuery(context.req.url, true));
      const body = await scopedRead(context.get('scoped'), (q) => workspaceUsage(q, window));
      return json({ ...windowFields(window), ...body });
   });

   route.get('/:workspaceId/agents/:agentId', async (context) => {
      const window = usageWindow(parseQuery(context.req.url, true));
      const agentId = pathId(context.req.param('agentId'), 'Agent');
      const db = context.get('scoped');
      try {
         await db.requireResource('agents', agentId);
      } catch (error) {
         throw toApiError(error, 'Agent');
      }
      const body = await scopedRead(db, (q) => agentUsage(q, agentId, window));
      return json({ ...windowFields(window), ...body });
   });

   route.get('/:workspaceId/runtimes/:runtimeId', async (context) => {
      const window = usageWindow(parseQuery(context.req.url, true));
      const raw = context.req.param('runtimeId');
      const runtimeId = raw === 'default' ? null : pathId(raw, 'Runtime');
      const db = context.get('scoped');
      if (runtimeId !== null && !(await scopedRead(db, (q) => runtimeVisible(q, runtimeId)))) {
         throw ApiError.notFound('Runtime');
      }
      const body = await scopedRead(db, (q) => runtimeUsage(q, runtimeId, window));
      return json({ ...windowFields(window), ...body });
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
      const window = usageWindow(parseQuery(context.req.url, true));
      const body = await scopedRead(context.get('scoped'), (q) => dashboardOverview(q, window));
      return json({ ...windowFields(window), ...body });
   });

   return route;
}

function windowFields(window: UsageWindow) {
   return { currency: 'USD', days: window.days, from: window.from, to: window.to };
}

/**
 * The only query parameter is `days`, and only on windowed reads. An
 * unrecognised parameter is a typo, and a read that ignored it would answer
 * a question nobody asked.
 */
function parseQuery(rawUrl: string, allowDays: boolean): number {
   const params = new URL(rawUrl).searchParams;
   const errors: FieldError[] = [];
   for (const name of new Set(params.keys())) {
      if (!(allowDays && name === 'days')) {
         errors.push(fieldError(`/${name}`, 'unknown', `${name} is not a parameter of this read.`));
      }
   }
   let days = DEFAULT_DAYS;
   const raw = allowDays ? params.get('days') : null;
   if (raw !== null) {
      const parsed = /^\d{1,3}$/.test(raw) ? Number(raw) : NaN;
      if (!(parsed >= 1 && parsed <= MAX_DAYS)) {
         errors.push(fieldError('/days', 'invalid_value', `days is a whole number from 1 to ${MAX_DAYS}.`));
      } else {
         days = parsed;
      }
   }
   assertValid(errors);
   return days;
}

/** One scoped read that returns a value rather than rows. */
async function scopedRead<T>(db: ScopedDb, read: (q: ScopedQuery) => Promise<T>): Promise<T> {
   const [value] = await db.list(async (q) => [await read(q)]);
   if (value === undefined) throw new Error('a scoped read returned nothing');
   return value;
}
