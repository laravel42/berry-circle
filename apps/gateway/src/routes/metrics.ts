import { Hono } from "hono";
import { config } from "~/config";
import { PROMETHEUS_CONTENT_TYPE, renderMetrics } from "~/observability";
import type { AppEnv } from "~/types";

/**
 * `GET /metrics` — Prometheus scrape endpoint. Served from the gateway itself
 * (the OpenTelemetry Prometheus exporter runs with `preventServerStart`), so it
 * shares the app's port, middleware, and lifecycle.
 */
export const metrics = new Hono<AppEnv>().get(config.METRICS_PATH, async (c) => {
  if (!config.METRICS_ENABLED) {
    return c.json({ error: { code: "NOT_FOUND", message: "Metrics are disabled" } }, 404);
  }
  const body = await renderMetrics();
  return c.body(body, 200, { "content-type": PROMETHEUS_CONTENT_TYPE });
});
