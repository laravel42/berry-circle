import { Hono } from 'hono';
import { ApiError, buildErrorEnvelope } from '../http/errors.ts';
import { json } from '../http/app.ts';
import type { Mount } from '../http/registry.ts';
import { renderMetrics, type MetricsSource } from '../observability/metrics.ts';

/**
 * Process health and the browser-safe capability list.
 *
 * The first mount to move, because it is the least coupled thing the server
 * answers: no authentication, no workspace scoping, and one dependency it can
 * probe directly. If the strangler works at all it works here first.
 */

/** A named readiness probe. Throwing means not ready. */
export type Checker = () => Promise<void>;

/** Only booleans, and only ones safe to hand a browser. */
export interface Capabilities {
   agentExecution: boolean;
   metrics: boolean;
   realtime: boolean;
   storage: boolean;
   valkey: boolean;
   planner: boolean;
}

export interface PlatformOptions {
   /** Required: a server that cannot reach the database is not ready. */
   database: Checker;
   /** Optional probes; an absent one is treated as passing, as in Go. */
   checks?: Record<string, Checker | undefined>;
   capabilities: Capabilities;
   /** Null on a deployment that reports `metrics: false`; the route then 404s. */
   metrics?: MetricsSource | null;
}

export function platformMounts(options: PlatformOptions): Mount[] {
   return [
      { prefix: '/health', handler: healthRoute() },
      { prefix: '/ready', handler: readyRoute(options) },
      { prefix: '/readyz', handler: readyRoute(options) },
      { prefix: '/metrics', handler: metricsRoute(options.metrics ?? null) },
      { prefix: '/api/v1/config', handler: configRoute(options.capabilities) },
   ];
}

function healthRoute(): Hono {
   const route = new Hono();
   route.get('/', () => json({ status: 'ok' }));
   return route;
}

function readyRoute(options: PlatformOptions): Hono {
   const route = new Hono();
   route.get('/', async () => {
      const probes: Record<string, Checker | undefined> = {
         database: options.database,
         ...options.checks,
      };

      // Sorted, because Go marshals map[string]bool with its keys sorted and
      // the response body is compared whole.
      const checks: Record<string, boolean> = {};
      let ready = true;
      for (const name of Object.keys(probes).sort()) {
         const probe = probes[name];
         const passed = probe === undefined || (await passes(probe));
         checks[name] = passed;
         ready &&= passed;
      }

      if (!ready) {
         // Not the ApiError path: this one carries details, and it is the only
         // place a readiness failure is described.
         const { status, body } = buildErrorEnvelope(
            503,
            'NOT_READY',
            'Service is not ready.',
            { checks },
            ''
         );
         return json(body, status);
      }
      // `checks` before `status`: Go sorts map keys and "c" precedes "s".
      return json({ checks, status: 'ready' });
   });
   return route;
}

/**
 * The Prometheus endpoint.
 *
 * Unauthenticated, like `/health`, because a scraper is not a session and
 * every number here is an aggregate: how many runs are queued, how many tasks
 * are done. Nothing identifies a workspace, a person or a piece of work, so
 * there is nothing here to protect that binding to a private network does not
 * already protect better.
 *
 * A deployment with metrics off answers the ordinary error envelope rather
 * than the router's bare not-found, so a scraper is told rather than left to
 * infer it from an empty graph.
 */
function metricsRoute(source: MetricsSource | null): Hono {
   const route = new Hono();
   route.get('/', async () => {
      if (!source) throw ApiError.routeNotFound();
      return new Response(await renderMetrics(source), {
         headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' },
      });
   });
   return route;
}

function configRoute(capabilities: Capabilities): Hono {
   const route = new Hono();
   route.get('/', () =>
      // Declaration order, not sorted: the Go server marshalled this as a
      // struct and `planner` was declared after `valkey`.
      json({
         capabilities: {
            agentExecution: capabilities.agentExecution,
            metrics: capabilities.metrics,
            realtime: capabilities.realtime,
            storage: capabilities.storage,
            valkey: capabilities.valkey,
            planner: capabilities.planner,
         },
      })
   );
   return route;
}

async function passes(probe: Checker): Promise<boolean> {
   try {
      await probe();
      return true;
   } catch {
      return false;
   }
}
