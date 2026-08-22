import type { Logger } from "pino";
import { logger as rootLogger } from "~/logger";
import { getRequestContext, getTraceHeaders } from "~/observability/context";
import { recordOpenfangClientRequest } from "~/observability/metrics";

export interface TracedFetchOptions {
  /**
   * Low-cardinality label for metrics/logs, e.g. `GET /api/agents/:id`. Keep it
   * templated — never interpolate ids — so the metric attribute set stays bounded.
   */
  route: string;
  /** Override the logger; defaults to the active request logger, then the root. */
  logger?: Logger;
}

function methodOf(input: string | URL | Request, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (input instanceof Request) return input.method.toUpperCase();
  return "GET";
}

/**
 * `fetch` wrapper for outbound gateway → OpenFang calls. It merges W3C trace
 * headers from the active request context (so the substrate can correlate the
 * work), records the `openfang.client.request.duration` metric, and logs the
 * outcome. Caller-supplied headers win over injected trace headers.
 *
 * The OpenFang adapter (BERR-20) should route every upstream request through
 * this helper — or, at minimum, spread {@link getTraceHeaders} into its headers.
 */
export async function tracedFetch(
  input: string | URL | Request,
  init: RequestInit | undefined,
  opts: TracedFetchOptions,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  for (const [key, value] of Object.entries(getTraceHeaders())) {
    if (!headers.has(key)) {
      headers.set(key, value);
    }
  }

  const method = methodOf(input, init);
  const log = opts.logger ?? getRequestContext()?.logger ?? rootLogger;
  const start = performance.now();

  try {
    const res = await fetch(input, { ...init, headers });
    const durationSeconds = (performance.now() - start) / 1000;
    recordOpenfangClientRequest({ method, route: opts.route, status: res.status, durationSeconds });
    log.debug(
      {
        openfang: {
          method,
          route: opts.route,
          status: res.status,
          durationMs: durationSeconds * 1000,
        },
      },
      "openfang.request",
    );
    return res;
  } catch (err) {
    const durationSeconds = (performance.now() - start) / 1000;
    recordOpenfangClientRequest({ method, route: opts.route, status: "error", durationSeconds });
    log.warn({ err, openfang: { method, route: opts.route } }, "openfang.request.failed");
    throw err;
  }
}
