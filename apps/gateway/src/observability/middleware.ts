import type { MiddlewareHandler } from "hono";
import { config } from "~/config";
import { logger } from "~/logger";
import {
  type RequestContext,
  generateSpanId,
  generateTraceId,
  parseTraceparent,
  runWithContext,
} from "~/observability/context";
import { markRequestEnd, markRequestStart } from "~/observability/metrics";
import type { AppEnv } from "~/types";

// Paths whose successful completions are logged at debug to avoid drowning the
// log in health probes and metric scrapes. Errors on them still surface.
function isQuietPath(path: string): boolean {
  return path === "/health" || path === config.METRICS_PATH;
}

/**
 * Establishes the per-request observability context and emits one structured
 * completion log line + request metrics per request:
 *
 * - continues an inbound W3C `traceparent` (or starts a fresh trace),
 * - binds a request-scoped child logger and exposes it on `c` and via
 *   {@link runWithContext} for downstream (OpenFang adapter) propagation,
 * - echoes `x-trace-id` on the response for client-side correlation,
 * - records inbound request duration + in-flight count.
 *
 * Mount it after `hono/request-id` so `c.get("requestId")` is populated.
 */
export function observability(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const requestId = c.get("requestId") ?? crypto.randomUUID();
    const parent = parseTraceparent(c.req.header("traceparent"));
    const traceId = parent?.traceId ?? generateTraceId();
    const traceFlags = parent?.flags ?? "01";
    const spanId = generateSpanId();

    const reqLogger = logger.child({ requestId, traceId });
    const ctx: RequestContext = { requestId, traceId, spanId, traceFlags, logger: reqLogger };

    c.set("traceId", traceId);
    c.set("logger", reqLogger);
    c.header("x-trace-id", traceId);

    const method = c.req.method;
    const path = c.req.path;
    const start = performance.now();

    markRequestStart();
    try {
      await runWithContext(ctx, () => next());
    } finally {
      const durationMs = performance.now() - start;
      const status = c.res.status;
      // Prefer the matched route pattern over the raw path to bound metric cardinality.
      const route = c.req.routePath || path;
      markRequestEnd({ method, route, status, durationSeconds: durationMs / 1000 });

      const line = {
        method,
        path,
        route,
        status,
        durationMs: Math.round(durationMs * 1000) / 1000,
      };
      if (status >= 500) {
        reqLogger.error(line, "request.completed");
      } else if (status >= 400) {
        reqLogger.warn(line, "request.completed");
      } else if (isQuietPath(path)) {
        reqLogger.debug(line, "request.completed");
      } else {
        reqLogger.info(line, "request.completed");
      }
    }
  };
}
