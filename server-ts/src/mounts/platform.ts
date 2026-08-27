import { Hono } from 'hono';
import { ApiError, buildErrorEnvelope } from '../http/errors.ts';
import { json } from '../http/app.ts';
import type { Mount } from '../http/registry.ts';

/**
 * Process health and the browser-safe capability list, ported from
 * server/internal/handlers/platform/handlers.go.
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
   workflows: boolean;
}

export interface PlatformOptions {
   /** Required: a server that cannot reach the database is not ready. */
   database: Checker;
   /** Optional probes; an absent one is treated as passing, as in Go. */
   checks?: Record<string, Checker | undefined>;
   capabilities: Capabilities;
}

export function platformMounts(options: PlatformOptions): Mount[] {
   return [
      { prefix: '/health', handler: healthRoute() },
      { prefix: '/ready', handler: readyRoute(options) },
      { prefix: '/readyz', handler: readyRoute(options) },
      { prefix: '/metrics', handler: metricsRoute() },
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
 * Metrics are not served yet.
 *
 * Go answers 404 with the ordinary envelope when metrics are disabled, so an
 * unimplemented endpoint here is indistinguishable from a disabled one there —
 * which is what the strangler needs while this mount is split across two
 * servers. Prometheus wiring lands with the observability port.
 */
function metricsRoute(): Hono {
   const route = new Hono();
   route.get('/', () => {
      throw ApiError.routeNotFound();
   });
   return route;
}

function configRoute(capabilities: Capabilities): Hono {
   const route = new Hono();
   route.get('/', () =>
      // Declaration order, not sorted: Go marshals this as a struct, and
      // planner and workflows are declared after valkey.
      json({
         capabilities: {
            agentExecution: capabilities.agentExecution,
            metrics: capabilities.metrics,
            realtime: capabilities.realtime,
            storage: capabilities.storage,
            valkey: capabilities.valkey,
            planner: capabilities.planner,
            workflows: capabilities.workflows,
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
