import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { json } from '../http/app.ts';
import { ApiError } from '../http/errors.ts';
import type { Mount } from '../http/registry.ts';
import { pathId } from './shared.ts';
import type { AdkExecutor } from '../agents/executor.ts';
import { RunConflict, RunNotFound, RunTerminal } from '../runs/ledger.ts';

/**
 * The seam through which Berry's own worker asks this server to run an agent.
 *
 * It is `/internal/`, not `/api/`, for two reasons. The frontend proxy
 * forwards only `/api/*`, so nothing here is reachable from a browser even by
 * accident; and the audience is one caller with a shared secret rather than a
 * session, so it does not belong in the surface the session middleware
 * guards.
 *
 * This is temporary by construction. Once the orchestration is ported the
 * executor is called in-process and this mount goes away with the Go worker
 * that needs it.
 */

export interface InternalRunOptions {
   executor: AdkExecutor | null;
   /** Null refuses every request: the surface is off, not open. */
   token: string | null;
}

export function internalRunMounts(options: InternalRunOptions): Mount[] {
   const route = new Hono();

   /**
    * Executes one run to completion and answers with its outcome.
    *
    * Synchronous on purpose. The caller is a Temporal activity whose whole
    * job is to wait for this, and answering early would leave the workflow
    * with no way to learn how the run ended other than polling the ledger it
    * is already being told about.
    */
   route.post('/:runId/execute', async (context) => {
      authorize(context.req.raw.headers, options.token);
      if (!options.executor) {
         // A server without a model credential cannot run agents, and saying
         // so is better than accepting the request and failing every run.
         throw new ApiError(
            503,
            'AGENT_RUNTIME_UNAVAILABLE',
            'This server is not configured to execute agent runs.'
         );
      }

      const runId = pathId(context.req.param('runId'), 'Run');
      const controller = new AbortController();
      // A client that gives up is a run nobody is waiting for. Aborting stops
      // the model call rather than paying it out to the end.
      context.req.raw.signal.addEventListener('abort', () => controller.abort(), { once: true });

      try {
         const outcome = await options.executor.execute(runId, controller.signal);
         return json(outcome);
      } catch (error) {
         throw toApiError(error);
      }
   });

   return [{ prefix: '/internal/runs', handler: route }];
}

/**
 * A shared secret, compared in constant time.
 *
 * Length is checked separately because timingSafeEqual throws on a length
 * mismatch rather than returning false, and the check itself leaks only the
 * length — which an attacker who can count bytes of a header they wrote
 * already knows.
 */
function authorize(headers: Headers, token: string | null): void {
   if (!token) throw ApiError.notFound('Run');

   const presented = headers.get('x-berry-internal-token') ?? '';
   const expected = Buffer.from(token, 'utf8');
   const actual = Buffer.from(presented, 'utf8');
   if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Authentication is required.');
   }
}

function toApiError(error: unknown): unknown {
   if (error instanceof RunNotFound) return ApiError.notFound('Run');
   if (error instanceof RunTerminal) {
      return new ApiError(409, 'RUN_TERMINAL', 'This run has already finished.');
   }
   if (error instanceof RunConflict) {
      return new ApiError(409, 'RUN_ALREADY_CLAIMED', 'This run is already being executed.');
   }
   return error;
}
